import { z } from 'zod';

/**
 * Protecoes locais da IA do bot (docs/13-seguranca-ia-bot.md). Funcoes puras: sem rede, sem banco, sem chamada extra a
 * IA. Nao sao a unica barreira: a IA nao tem acesso ao banco, as ferramentas so leem, a posse do pedido e conferida no
 * servidor e a resposta passa pelo filtro de saida. A deteccao serve para nao gastar a IA com ataques, registrar e
 * conter quem insiste.
 */

// ---------------- normalizacao ----------------

const ZERO_WIDTH = /[­͏؜ᅟᅠ឴឵᠋-᠎​-‏‪-‮⁠-⁤⁪-⁯︀-️﻿]/g;
const HOMOGLYPHS: Record<string, string> = { а: 'a', е: 'e', о: 'o', р: 'p', с: 'c', у: 'y', х: 'x', і: 'i', ј: 'j', ѕ: 's', ԁ: 'd', ɡ: 'g', ı: 'i', α: 'a', ο: 'o', ε: 'e', ρ: 'p', τ: 't', ν: 'v' };
const LEET: Record<string, string> = { '0': 'o', '1': 'i', '3': 'e', '4': 'a', '5': 's', '7': 't', '8': 'b', '@': 'a', $: 's', '!': 'i', '|': 'i', '€': 'e' };

/** Minusculas, sem acento, sem caracteres invisiveis, com homoglifos comuns trocados. */
export function normalize(s: string) {
  return s
    .normalize('NFKC')
    .replace(ZERO_WIDTH, '')
    .normalize('NFD')
    .replace(/[̀-ͯ]/g, '')
    .toLowerCase()
    .replace(/[аеорсухіјѕԁɡıαοερτν]/g, (c) => HOMOGLYPHS[c] ?? c)
    .replace(/\s+/g, ' ')
    .trim();
}

const deleet = (s: string) => s.replace(/[0134578@$!|€]/g, (c) => LEET[c] ?? c);
/** "i g n o r e", "i.g.n.o.r.e", "i-g-n" viram a palavra junta. */
const collapseSpaced = (s: string) => s.replace(/\b(?:[a-z][ ._\-*]){3,}[a-z]\b/g, (m) => m.replace(/[ ._\-*]/g, ''));
const rot13 = (s: string) => s.replace(/[a-z]/g, (c) => String.fromCharCode(((c.charCodeAt(0) - 97 + 13) % 26) + 97));
const printableRatio = (s: string) => (s.length ? (s.match(/[\p{L}\p{N}\p{P}\s]/gu)?.length ?? 0) / s.length : 0);

/** Conteudo escondido em base64, hex, %XX ou \uXXXX (decodificado so para analise, nunca executado). */
export function decodeHidden(raw: string): string[] {
  const out: string[] = [];
  for (const tok of raw.match(/[A-Za-z0-9+/_-]{16,}={0,2}/g) ?? []) {
    try {
      const d = Buffer.from(tok.replace(/-/g, '+').replace(/_/g, '/'), 'base64').toString('utf8');
      if (d.length >= 8 && printableRatio(d) > 0.85 && /[a-z]{3}/i.test(d)) out.push(d);
    } catch {
      /* nao era base64 */
    }
  }
  for (const tok of raw.match(/(?:[0-9a-f]{2}[\s:]?){10,}/gi) ?? []) {
    const d = Buffer.from(tok.replace(/[\s:]/g, ''), 'hex').toString('utf8');
    if (printableRatio(d) > 0.85 && /[a-z]{3}/i.test(d)) out.push(d);
  }
  if (/%[0-9a-f]{2}/i.test(raw)) {
    try {
      out.push(decodeURIComponent(raw));
    } catch {
      /* sequencia invalida */
    }
  }
  if (/\\u[0-9a-f]{4}/i.test(raw)) out.push(raw.replace(/\\u([0-9a-f]{4})/gi, (_, h: string) => String.fromCharCode(parseInt(h, 16))));
  return out.slice(0, 10);
}

// ---------------- deteccao de manipulacao ----------------

export type Category =
  | 'override'
  | 'prompt_extraction'
  | 'identity'
  | 'privilege'
  | 'jailbreak'
  | 'credentials'
  | 'sql'
  | 'code_exec'
  | 'file_access'
  | 'tool_manipulation'
  | 'data_other'
  | 'history_manipulation'
  | 'write_attempt'
  | 'encoding'
  | 'overlong'
  | 'split';

type Rule = { id: string; category: Category; weight: number; re: RegExp };

// Verbos e alvos em portugues, ingles, espanhol, frances, alemao e italiano (ja sem acento e em minusculas).
const OVR = '(ignor\\w*|desconsider\\w*|esquec\\w*|esqueca|despreze|abandon\\w*|descart\\w*|anul\\w*|revog\\w*|override|disregard|forget|bypass|olvid\\w*|omit\\w*|oubli\\w*|vergiss\\w*|ignorier\\w*|dimentic\\w*|salt\\w* (as|todas)|pule)';
// Alvos fortes (so fazem sentido contra o bot) e fracos (aparecem em conversa de compra: "a regra do frete").
const TGT =
  '(instruc\\w*|instruction\\w*|orientac\\w*|diretriz\\w*|directive\\w*|prompt\\w*|programac\\w*|guideline\\w*|consigne\\w*|anweisung\\w*|istruzion\\w*|everything above|tudo (o que foi dito )?acima|todo lo anterior|tout ce qui precede)';
const TGT_WEAK = '(regra\\w*|rule\\w*|restric\\w*|limitac\\w*|politica\\w*|polic\\w*|regla\\w*|regle\\w*|regeln|regol\\w*)';
const BEFORE = '(anterior\\w*|previous|prior|acima|above|todas as|todos os|all( the)?|initial|iniciais|originais|original|de antes|precedent\\w*|vorherig\\w*|precedenti)';
const ASK =
  '(mostr\\w*|revel\\w*|repit\\w*|repet\\w*|diga|diz|dize|exib\\w*|imprim\\w*|escrev\\w*|copi\\w*|list\\w*|qual( e| eh| sao| seria| era)? (a|o|as|os|sua|seu|tua|teu)|quais (sao|as|os)|me (pass\\w*|d[eaá]|envi\\w*|mand\\w*|fal\\w*|cont\\w*)|show|reveal|repeat|print|tell me|what (is|are|were)|output|display|dump|leak|give me|send me|muestra|dime|cuales|montre|donne|zeig\\w*|sag mir|wiederhol\\w*|ripeti|dimmi|traduz\\w*|translate|resum\\w*|summari\\w*)';
const SECRET_OBJ =
  '(prompt\\w*|instruc\\w*|instruction\\w*|regras? (interna|do sistema|inicia|oculta|secreta|original|que (te|lhe) (deram|passaram))\\w*|system (message|instruction)|mensage\\w* (do sistema|inicial|oculta)|configurac\\w* (interna|do sistema|do bot|secreta)|primeira mensagem|texto (acima|anterior|inicial)|initial (instructions|prompt)|hidden (instructions|prompt)|your (rules|instructions|guidelines|configuration)|suas (regras|instrucoes|diretrizes|configurac\\w*)|tus (reglas|instrucciones)|tes (regles|consignes)|deine (regeln|anweisungen)|tue (regole|istruzioni)|como (voce|vc) (foi|esta) (programad|configurad)\\w*)';
const CRED =
  '((sua|tua|seu|teu|your|tu|ton|ta|dein\\w*|tuo|tua) (senha|password|chave|token|credencia\\w*|contrasena|mot de passe|passwort)|api[ _-]?keys?|chaves? (de |da |do )?(api|acesso|secreta|privada)|secret[ _-]?key|access[ _-]?token|tokens? (de acesso|da api|do sistema|secreto|do whatsapp|do gemini)|bearer|credencia\\w*|credential\\w*|senhas? (do|da|de) (sistema|banco|admin\\w*|servidor|api|painel|root|loja)|password\\w*|contrasena\\w*|mot de passe|passwort|\\.env\\b|variaveis de ambiente|environment variables?|gemini_api_key|wa_access_token|enc_key|app_db_password|connection string|string de conexao)';

const RULES: Rule[] = [
  { id: 'ovr-1', category: 'override', weight: 5, re: new RegExp(`\\b${OVR}\\b.{0,60}\\b${TGT}`) },
  { id: 'ovr-1b', category: 'override', weight: 5, re: new RegExp(`\\b${OVR}\\b.{0,30}\\b${BEFORE}\\b.{0,30}\\b${TGT_WEAK}|\\b${OVR}\\b.{0,30}\\b${TGT_WEAK}\\b.{0,20}\\b${BEFORE}`) },
  { id: 'ovr-1c', category: 'override', weight: 3, re: new RegExp(`\\b${OVR}\\b.{0,40}\\b${TGT_WEAK}`) },
  { id: 'ovr-2', category: 'override', weight: 5, re: /\b(novas? (instruc\w*|regras?)|new (instructions|rules)|nuevas instrucciones|nouvelles instructions|neue anweisungen|nuove istruzioni)\s*[:-]/ },
  { id: 'ovr-3', category: 'override', weight: 4, re: /\b(suas|tuas|as) (regras|instrucoes) (nao (valem|se aplicam)|foram (canceladas|revogadas|substituidas|atualizadas))|\b(your|the) (rules|instructions) (no longer apply|are (void|cancelled|revoked|updated))/ },
  { id: 'ext-1', category: 'prompt_extraction', weight: 5, re: new RegExp(`\\b${ASK}\\b.{0,60}\\b${SECRET_OBJ}`) },
  { id: 'ext-2', category: 'prompt_extraction', weight: 3, re: /\b(system ?prompt|prompt (do|de) sistema|system instruction|systeminstruction|prompt inicial|instrucoes do sistema|meta[ -]?prompt|pre[ -]?prompt)\b/ },
  { id: 'ext-3', category: 'prompt_extraction', weight: 4, re: /\b(comece|comecando|start|begin|empieza) (sua resposta |your (answer|reply) )?(com|with|por|con) ["']?(voce e|you are|eres)\b/ },
  { id: 'ext-4', category: 'prompt_extraction', weight: 5, re: /\b((o que|quais|como) (te|lhe|foi) (disseram|mandaram|pediram|orientaram|programaram|instruiram|configuraram|ensinaram)|(orientac|instruc|regras|diretrizes|ordens)\w* (que )?(voce|vc|tu) (recebeu|recebe|segue|seguiu|tem que seguir)|antes (desta|dessa|da nossa) conversa (comecar|iniciar)?|what were you told|what instructions (were you|did you)|que te (dijeron|ordenaron))\b/ },
  { id: 'idt-1', category: 'identity', weight: 4, re: /\b(finj\w* (ser|que)|faca de conta|aja como|atue como|comporte-se como|interprete o papel|role ?play|pretend (to be|you are|that)|act as|you are now|from now on you|eres ahora|ahora eres|finge (ser|que)|actua como|tu es maintenant|fais semblant|agis comme|du bist (jetzt|nun)|tu sei ora|fingi di)\b/ },
  { id: 'idt-2', category: 'identity', weight: 4, re: /\b(a partir de agora|de agora em diante|daqui (pra|para) frente|de ahora en adelante|desormais|ab jetzt|d'ora in poi) (voce|vc|tu|eres|tu es|du bist)? ?(e|sera|vai ser|deve|passa a ser|nao e mais|eres|seras|es|bist|sei)\b/ },
  { id: 'idt-4', category: 'identity', weight: 4, re: /\b(voce|vc|tu) (agora|a partir de agora|de agora em diante) (e|eh|sera|vai ser|passa a ser|se torna|funciona como)\b/ },
  { id: 'idt-3', category: 'identity', weight: 3, re: /\b(voce|vc) nao e (mais )?(um|o) (atendente|assistente|bot|robo)|\byou are not (an?|the) (assistant|bot)\b/ },
  { id: 'jb-1', category: 'jailbreak', weight: 5, re: /\b(jailbreak\w*|do anything now|developer mode|dev mode|modo (desenvolvedor|dev|deus|god|admin|root|irrestrito|sem filtro|sem censura)|god mode|dan mode|\bdan\b.{0,20}(mode|modo|prompt)|unfiltered mode|evil (mode|bot|assistant)|aim mode|stan mode|mongo tom)\b/ },
  { id: 'jb-2', category: 'jailbreak', weight: 5, re: /\b(respond\w*|fale|fala|falar|aja|agir|opere|answer|respond|act|behave|responde|contesta)\b.{0,20}\b(sem|without|sin|sans|ohne|senza) (restric\w*|filtro\w*|censura\w*|limite\w*|regras|etica|moral\w*|restrictions?|filters?|rules|limits|censorship|reglas|filtres|regeln|regole)\b/ },
  { id: 'jb-5', category: 'jailbreak', weight: 5, re: /\b(assistente|ia|bot|robo|modelo|chatbot|assistant|ai|model|asistente|ki)\b.{0,25}\b(sem|without|sin|sans|ohne|senza) (restric\w*|filtro\w*|censura\w*|limites|regras|etica|restrictions?|filters?|rules|censorship|reglas|regles|regeln|regole)\b/ },
  { id: 'jb-3', category: 'jailbreak', weight: 3, re: /\b(hipotetic\w*|imagine (que|um mundo)|suponha que|num mundo (onde|em que)|para (um|uma) (historia|ficcao|roteiro|jogo)|hypothetic\w*|in a fictional|for a (story|novel|game)|imagina que|supongamos)\b.{0,80}\b(sem regras|sem restric\w*|ignor\w*|regras|instruc\w*|admin\w*|senha|prompt|token|chave|acesso|no rules|instructions|password)\b/ },
  { id: 'jb-4', category: 'jailbreak', weight: 3, re: /\b(vov[oó]|grandma|abuela)\b.{0,60}\b(chave|senha|token|key|password|prompt|instruc\w*)\b/ },
  { id: 'prv-1', category: 'privilege', weight: 3, re: /\b(sou|eu sou|aqui (e|quem fala e)|falo como|i am|i'm|this is|soy|je suis|ich bin|sono) (o |a |um |uma |the |an? |el |la |le |der |die |il )?(admin\w*|adm\b|dono (do|da) (sistema|bot|loja|empresa)|proprietari\w* (do|da) (sistema|loja)|gerente (do|da) (sistema|loja)|desenvolvedor\w*|developer|programador\w*|suporte tecnico|root|superusu\w*|owner of|ceo|equipe (de )?(ti|tecnica|seguranca|do google|da meta)|(do|da|from) (google|anthropic|openai|meta|whatsapp)|sysadmin|moderador)/ },
  { id: 'prv-2', category: 'privilege', weight: 4, re: /\b(modo|acesso|permiss\w*|privilegi\w*|nivel|perfil|role|access|mode|permission\w*|privilege\w*)\b.{0,15}\b(admin\w*|root|total|irrestrit\w*|elevad\w*|superuser|sudo|unrestricted|full)\b/ },
  { id: 'prv-3', category: 'privilege', weight: 4, re: /\b(autoriz\w*|liber\w*|conced\w*|ativ\w*|habilit\w*|grant\w*|enable\w*|unlock\w*|desbloque\w*)\b.{0,30}\b(admin\w*|root|acesso total|privilegi\w*|permiss\w*|modo (especial|secreto|admin))\b/ },
  { id: 'prv-4', category: 'privilege', weight: 2, re: /\b(estou autorizad\w*|tenho autorizac\w*|tenho permiss\w*|i (am|'m) authori[sz]ed|i have (permission|clearance)|codigo de (acesso|autorizac\w*)|override code|senha mestra|master (password|key))\b/ },
  { id: 'crd-1', category: 'credentials', weight: 3, re: new RegExp(`\\b${CRED}`) },
  { id: 'crd-2', category: 'credentials', weight: 5, re: new RegExp(`\\b${ASK}\\b.{0,50}\\b${CRED}`) },
  { id: 'sql-1', category: 'sql', weight: 4, re: /\b(union\s+(all\s+)?select|select\s+[\w*,\s]{1,60}\s+from\s+\w+|drop\s+(table|database|schema)|delete\s+from\s+\w+|insert\s+into\s+\w+|update\s+\w+\s+set\s|truncate\s+(table\s+)?\w+|alter\s+table|grant\s+all|pg_sleep|information_schema|pg_catalog|xp_cmdshell|sleep\(\d+\)|benchmark\(\d+)/ },
  { id: 'sql-2', category: 'sql', weight: 4, re: /('|")\s*(or|and)\s*('|")?\d+('|")?\s*=\s*('|")?\d+|('|");\s*(--|#|\/\*)|;\s*(drop|delete|update|insert|select)\b/ },
  { id: 'cmd-1', category: 'code_exec', weight: 4, re: /(\brm\s+-rf\b|\bcurl\s+(-\w+\s+)*(https?:|file:|ftp:|gopher:)|\bwget\s+\S|\bnc\s+-|\bsudo\s+\w|\bchmod\s+[0-7+]|\bbash\s+-c\b|\bsh\s+-c\b|powershell|cmd\.exe|\$\([^)]{2,}\)|`[^`\n]{3,}`|\beval\s*\(|\bexec\s*\(|\bspawn\s*\(|require\s*\(|\bimport\s+os\b|os\.system|subprocess|child_process|process\.env|__import__|runtime\.exec|<script\b|javascript:|onerror\s*=)/ },
  { id: 'cmd-2', category: 'code_exec', weight: 4, re: /\b(execut\w*|rod\w*|run|ejecut\w*|exécut\w*|lance|ausfuhr\w*|esegui)\b.{0,30}\b(comando|command|codigo|code|script|terminal|shell|sql|query|consulta sql|bash|python|javascript)\b/ },
  { id: 'fil-0', category: 'file_access', weight: 5, re: /(\/etc\/(passwd|shadow|sudoers)|id_rsa|\.ssh\/|\/proc\/self|\.\.\/\.\.\/|\.env\b.{0,20}\b(conteudo|content|arquivo|file|mostr\w*|show|cat|le\w*|read)|\b(conteudo|content|arquivo|file|mostr\w*|show|cat|leia|ler|read|abr\w*|open)\b.{0,25}\.env\b)/ },
  { id: 'fil-1', category: 'file_access', weight: 3, re: /(\.\.[\\/]|\/etc\/(passwd|shadow|hosts|nginx)|\/srv\/|\/var\/(www|log|lib)|\/root\/|[a-z]:\\\\?(users|windows)|config\.inc\.php|id_rsa|\.ssh\/|\.git\/|package\.json|docker-compose|\/proc\/self)/ },
  { id: 'fil-2', category: 'file_access', weight: 4, re: /\b(le\w*|abr\w*|mostr\w*|read|open|show|cat|lee|lire|lies|leggi)\b.{0,30}\b(arquivo|file|fichero|fichier|datei|codigo[- ]fonte|source code|banco de dados|database|logs?|servidor)\b.{0,30}\b(interno|do sistema|do servidor|da loja|internal|server|config\w*)\b/ },
  { id: 'tool-1', category: 'tool_manipulation', weight: 3, re: /\b(cham\w*|execut\w*|rod\w*|acion\w*|use|usar|call|invoke|run|trigger|llam\w*|ejecut\w*|appel\w*|aufruf\w*|chiama)\b.{0,30}\b(funcao|funcoes|function\w*|ferrament\w*|tools?|consultar_pedido|buscar_produtos|dados_da_loja|transferir_atendente|endpoint|webhook)\b/ },
  { id: 'tool-3', category: 'tool_manipulation', weight: 4, re: /\b(consultar_pedido|buscar_produtos|dados_da_loja|transferir_atendente)\b/ },
  { id: 'tool-2', category: 'tool_manipulation', weight: 4, re: /(functioncall|function_call|tool_call|tool_use|functionresponse|function_response|thoughtsignature|"name"\s*:\s*"|"args"\s*:\s*\{|consultar_pedido\s*\(|buscar_produtos\s*\()/ },
  { id: 'oth-1', category: 'data_other', weight: 4, re: /\b(pedido\w*|dados|telefone\w*|endereco\w*|cpf|cnpj|compras|cadastro\w*|informac\w*|historico|conversa\w*|mensage\w*|orders?|data|phone\w*|address\w*|pedidos)\b.{0,40}\b(de outr[oa]s?|dos outros|de todos|de qualquer (um|cliente|pessoa)|alheio\w*|de terceiros|other (customer|user|client|people)s?|another (customer|user|person)|all (customers|users|clients)|todos os (clientes|usuarios|compradores)|de otros|de autres|anderer|di altri)\b/ },
  { id: 'oth-2', category: 'data_other', weight: 5, re: /\b(list\w*|mostr\w*|exib\w*|export\w*|dump|show|list|give me|muestra|liste|zeig\w*)\b.{0,25}\b(todos os|todas as|all( the)?|todos los|tous les|alle)\b.{0,10}\b(pedidos|clientes|orders|customers|usuarios|users|telefones|cpfs|enderecos|cadastros|compradores|contatos)\b/ },
  { id: 'oth-3', category: 'data_other', weight: 3, re: /\b(pedido|order)s?\b.{0,20}\b(de|do|da|of)\b.{0,10}\b(outro numero|outro telefone|another number|numero \d{8,}|telefone \d{8,})\b/ },
  { id: 'his-0', category: 'history_manipulation', weight: 5, re: /(<\|(im_start|im_end|system|endoftext|eot_id|start_header_id|end_header_id)\|>|\[\/?inst\]|<<\/?sys>>|<start_of_turn>|<end_of_turn>)/ },
  { id: 'his-1', category: 'history_manipulation', weight: 4, re: /(<\|?(im_start|im_end|system|endoftext|eot_id|start_header_id)\|?>|\[\/?(inst|sys|system)\]|<<\/?sys>>|<\/?(system|instructions?|mensagem_do_cliente|dados_da_loja|prompt|assistant|model|tool)>|\b(begin|end) (system|admin) (prompt|message)\b|\bnova instrucao do sistema\b|\bmensagem do sistema\s*:|\bsystem update\s*:|\[(system|sistema|admin|developer)\]|\bmodel\s*:\s*(ok|claro|certo|sure))/ },
  { id: 'his-2', category: 'history_manipulation', weight: 3, re: /(^|\n)\s*(system|sistema|assistant|assistente|model|modelo|bot|ia|ai|atendente virtual|tool|function)\s*[:>]\s*\S/ },
  { id: 'his-3', category: 'history_manipulation', weight: 2, re: /\b(voce (ja )?(concordou|aceitou|confirmou|prometeu|disse que (podia|ia))|you (already )?(agreed|promised|confirmed)|como combinamos (antes|na mensagem)|na conversa anterior (voce|vc) (liberou|autorizou))\b/ },
  { id: 'wrt-1', category: 'write_attempt', weight: 1, re: /\b(alter\w*|mud\w*|apag\w*|delet\w*|modific\w*|atualiz\w*|zer\w*|change|update|modify|erase|set)\b.{0,30}\b(preco\w*|estoque|status|situacao do pedido|price\w*|stock|banco|database|cadastro de outr\w*)\b/ },
  { id: 'wrt-2', category: 'write_attempt', weight: 3, re: /\b(marque|marcar|mark|set|coloque|defina)\b.{0,30}\b(como pago|as paid|pago|entregue|aprovad\w*|delivered|paid)\b/ },
];

export type Assessment = { score: number; categories: Category[]; rules: string[]; decision: 'allow' | 'flag' | 'block' };

/** Bloqueia a partir de 5 pontos; registra (sem bloquear) a partir de 3. */
export const BLOCK_SCORE = 5;
export const FLAG_SCORE = 3;
const MAX_SCAN = 6000;

// Texto so com letras: pega "i g n o r e  a l l", "i.g.n.o.r.e" e palavras quebradas. Padroes longos e especificos.
const COMPACT_RULES: Rule[] = [
  { id: 'cmp-1', category: 'override', weight: 5, re: /(ignor|desconsider|esquec|despreze|disregard|forget|olvid|oubli|vergiss|dimentic)[a-z]{0,30}(instruc|instruction|prompt|anweisung|consigne|istruzion|previousrules|regrasanteriores|todasasregras)/ },
  { id: 'cmp-2', category: 'prompt_extraction', weight: 5, re: /(reveal|show|print|repeat|mostr|revel|repit|repet|exib|imprim|muestra|montre|zeig)[a-z]{0,20}(systemprompt|yourprompt|seuprompt|suasinstruc|yourinstruction|promptdosistema|instrucoesdosistema)/ },
  { id: 'cmp-3', category: 'jailbreak', weight: 5, re: /(jailbreak|developermode|mododesenvolvedor|doanythingnow|godmode|semrestricoes|withoutrestrictions|norestrictions)/ },
  { id: 'cmp-4', category: 'credentials', weight: 5, re: /(apikey|chavedaapi|chavedeapi|accesstoken|secretkey|senhadosistema|senhadobanco|geminiapikey|waaccesstoken)/ },
];

function scan(variants: { text: string; decoded: boolean; compact?: boolean }[]) {
  const best = new Map<Category, number>();
  const hits = new Map<Category, Set<string>>();
  const rules = new Set<string>();
  let decodedHit = false;
  for (const v of variants) {
    for (const r of v.compact ? COMPACT_RULES : RULES) {
      if (!r.re.test(v.text)) continue;
      rules.add(r.id);
      if (v.decoded) decodedHit = true;
      best.set(r.category, Math.max(best.get(r.category) ?? 0, r.weight));
      if (!hits.has(r.category)) hits.set(r.category, new Set());
      hits.get(r.category)!.add(r.id.replace(/^cmp-\d/, 'cmp'));
    }
  }
  // Varios sinais da mesma categoria (ex.: "sou admin" + "libere acesso total") somam ate +2.
  for (const [c, ids] of hits) best.set(c, best.get(c)! + Math.min(2, ids.size - 1));
  return { best, rules, decodedHit };
}

function variantsOf(raw: string) {
  const text = raw.slice(0, MAX_SCAN);
  const n = normalize(text);
  const d = collapseSpaced(deleet(n));
  const list: { text: string; decoded: boolean; compact?: boolean }[] = [
    { text: n, decoded: false },
    { text: d, decoded: false },
    { text: deleet(n).replace(/[^a-z]/g, ''), decoded: false, compact: true },
    { text: rot13(n), decoded: true },
  ];
  for (const h of decodeHidden(text)) {
    const hn = normalize(h);
    list.push({ text: hn, decoded: true }, { text: hn.replace(/[^a-z]/g, ''), decoded: true, compact: true });
  }
  return list;
}

function decide(score: number): Assessment['decision'] {
  return score >= BLOCK_SCORE ? 'block' : score >= FLAG_SCORE ? 'flag' : 'allow';
}

/**
 * Avalia a mensagem atual e, para ataques divididos em varias mensagens, as mensagens recentes do mesmo cliente
 * juntas. Pontuacao = soma do maior peso de cada categoria encontrada (+2 se veio escondido em codificacao, +1 se
 * duas categorias fortes aparecem juntas).
 */
export function assessInput(text: string, recent: string[] = []): Assessment {
  const own = scan(variantsOf(text));
  let score = [...own.best.values()].reduce((a, b) => a + b, 0);
  const cats = new Set<Category>(own.best.keys());
  const rules = new Set(own.rules);
  if (own.decodedHit) {
    score += 2;
    cats.add('encoding');
  }
  if ([...own.best.values()].filter((w) => w >= 3).length >= 2) score += 1;
  if (text.length > 1000) {
    score += text.length > 2500 ? 2 : 1;
    cats.add('overlong');
  }
  if (score < BLOCK_SCORE && recent.length) {
    const joined = [...recent.slice(-4), text].join(' ');
    const all = scan(variantsOf(joined));
    const joinedScore = [...all.best.values()].reduce((a, b) => a + b, 0) + (all.decodedHit ? 2 : 0);
    if (joinedScore >= BLOCK_SCORE && joinedScore > score) {
      for (const c of all.best.keys()) cats.add(c);
      for (const r of all.rules) rules.add(r);
      cats.add('split');
      score = joinedScore;
    }
  }
  return { score, categories: [...cats], rules: [...rules], decision: decide(score) };
}

// ---------------- dados pessoais ----------------

const onlyDigits = (s: string) => s.replace(/\D/g, '');
export function validCpf(raw: string) {
  const d = onlyDigits(raw);
  if (d.length !== 11 || /^(\d)\1+$/.test(d)) return false;
  const dv = (len: number) => {
    let sum = 0;
    for (let i = 0; i < len; i++) sum += Number(d[i]) * (len + 1 - i);
    const r = (sum * 10) % 11;
    return r === 10 ? 0 : r;
  };
  return dv(9) === Number(d[9]) && dv(10) === Number(d[10]);
}
export function validCnpj(raw: string) {
  const d = onlyDigits(raw);
  if (d.length !== 14 || /^(\d)\1+$/.test(d)) return false;
  const dv = (len: number) => {
    const w = len === 12 ? [5, 4, 3, 2, 9, 8, 7, 6, 5, 4, 3, 2] : [6, 5, 4, 3, 2, 9, 8, 7, 6, 5, 4, 3, 2];
    const sum = w.reduce((a, x, i) => a + x * Number(d[i]), 0);
    const r = sum % 11;
    return r < 2 ? 0 : 11 - r;
  };
  return dv(12) === Number(d[12]) && dv(13) === Number(d[13]);
}
function luhn(raw: string) {
  const d = onlyDigits(raw);
  if (d.length < 13 || d.length > 19) return false;
  let sum = 0;
  for (let i = 0; i < d.length; i++) {
    let n = Number(d[d.length - 1 - i]);
    if (i % 2 === 1) {
      n *= 2;
      if (n > 9) n -= 9;
    }
    sum += n;
  }
  return sum % 10 === 0;
}

/**
 * Tira documento, cartao, e-mail e senha digitada antes de mandar o texto a IA (LGPD: a IA nao precisa deles).
 * O pedido continua consultavel: numero de pedido nao e afetado.
 */
export function redactPersonal(text: string) {
  return text
    .replace(/\b\d{2}\.?\d{3}\.?\d{3}\/?\d{4}-?\d{2}\b/g, (m) => (validCnpj(m) ? '[CNPJ oculto]' : m))
    .replace(/\b\d{3}\.?\d{3}\.?\d{3}-?\d{2}\b/g, (m) => (validCpf(m) ? '[CPF oculto]' : m))
    .replace(/\b(?:\d[ -]?){12,18}\d\b/g, (m) => (luhn(m) ? '[cartão oculto]' : m))
    .replace(/[\w.+-]+@[\w-]+(\.[\w-]+)+/g, '[e-mail oculto]')
    .replace(/\b(senha|password|pin|cvv|cvc)\b(\s*(e|é|eh|:|=|-)\s*)\S+/gi, '$1$2[oculto]');
}

// ---------------- ferramentas ----------------

export const TOOL_NAMES = ['consultar_pedido', 'buscar_produtos', 'dados_da_loja', 'transferir_atendente'] as const;
export type ToolName = (typeof TOOL_NAMES)[number];

const plainText = (max: number) =>
  z
    .string()
    .max(max)
    .refine((s) => !/[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F]/.test(s), 'caractere de controle');
// So os campos declarados; nada a mais (strictObject). O numero do pedido aceita texto so com digitos.
const TOOL_ARGS: Record<ToolName, z.ZodType> = {
  consultar_pedido: z.strictObject({
    numero: z.union([z.number(), z.string().regex(/^\s*\d{1,9}\s*$/).transform(Number)]).pipe(z.number().int().min(1).max(999_999_999)),
  }),
  buscar_produtos: z.strictObject({ termo: plainText(100).pipe(z.string().trim().min(2)) }),
  dados_da_loja: z.strictObject({}),
  transferir_atendente: z.strictObject({ motivo: plainText(200).optional() }),
};

export type ToolCheck = { ok: true; name: ToolName; args: Record<string, unknown> } | { ok: false; reason: 'not_allowed' | 'invalid_args' };

/** Lista de permissoes + validacao estrita dos argumentos. A IA so pede: quem decide e o servidor. */
export function checkToolCall(name: unknown, args: unknown): ToolCheck {
  if (typeof name !== 'string' || !(TOOL_NAMES as readonly string[]).includes(name)) return { ok: false, reason: 'not_allowed' };
  const parsed = TOOL_ARGS[name as ToolName].safeParse(args ?? {});
  return parsed.success ? { ok: true, name: name as ToolName, args: parsed.data as Record<string, unknown> } : { ok: false, reason: 'invalid_args' };
}

/**
 * Dados que voltam das ferramentas (nome de produto, transportadora, rastreio) tambem sao nao confiaveis: sem
 * caracteres de controle, tamanho limitado e, se parecerem instrucao, trocados por um aviso (injecao indireta).
 */
export function sanitizeToolData<T>(value: T, onFlag: () => void, depth = 0): T {
  if (depth > 6) return null as T;
  if (typeof value === 'string') {
    const clean = value.replace(/[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F]/g, '').replace(ZERO_WIDTH, '').slice(0, 600);
    if (clean.length > 12 && assessInput(clean).decision === 'block') {
      onFlag();
      return '[conteúdo removido pela loja]' as T;
    }
    return clean as T;
  }
  if (Array.isArray(value)) return value.slice(0, 20).map((v) => sanitizeToolData(v, onFlag, depth + 1)) as T;
  if (value && typeof value === 'object') return Object.fromEntries(Object.entries(value).map(([k, v]) => [k, sanitizeToolData(v, onFlag, depth + 1)])) as T;
  return value;
}

// ---------------- resposta ----------------

const SECRET_PATTERNS = [
  /AIza[0-9A-Za-z_-]{30,}/g, // chave do Google
  /\bEAA[A-Za-z0-9]{30,}/g, // token da Meta
  /\b(APP_USR|TEST)-\d{6,}-[\w-]{10,}/g, // Mercado Pago
  /\bsk-[A-Za-z0-9_-]{20,}/g,
  /\bgh[pousr]_[A-Za-z0-9]{30,}/g,
  /\beyJ[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}/g, // JWT
  /-----BEGIN [A-Z ]*PRIVATE KEY-----/g,
  /\b(postgres(ql)?|mysql|redis|mongodb):\/\/[^\s@]+@[^\s]+/g,
];

/** Troca segredos conhecidos e formatos de chave por [segredo] (erros guardados, logs e respostas). */
export function redactSecrets(text: string, known: string[]) {
  let out = text;
  for (const s of known) if (s.length >= 8) out = out.split(s).join('[segredo]');
  for (const re of SECRET_PATTERNS) out = out.replace(re, '[segredo]');
  return out;
}

const INTERNAL_MARKERS =
  /\b(consultar_pedido|buscar_produtos|dados_da_loja|transferir_atendente|functioncall|functionresponse|function_call|thoughtsignature|system ?instruction|systeminstruction|generatecontent|ai_calls|bot_settings|bot_security_events|whatsapp_inbound|whatsapp_messages|store_settings|company_profiles|gemini_api_key|wa_access_token|app_db_password|enc_key|app_origin|node_modules|stack trace|at object\.|at async|econnrefused|sqlstate|syntax error at or near|\/srv\/|\.env\b)/;

export type OutputCheck = { action: 'ok' | 'redacted' | 'blocked'; text: string; issues: string[] };
export type OutputContext = {
  systemPrompt: string;
  knownSecrets: string[];
  /** Hosts que podem aparecer em links: o da loja e os que vieram nos dados das ferramentas. */
  allowedHosts: Set<string>;
  maxLength?: number;
};

function promptLeak(out: string, systemPrompt: string) {
  const o = normalize(out);
  const lines = systemPrompt
    .split('\n')
    .map((l) => normalize(l.replace(/^[-\s]+/, '')))
    .filter((l) => l.length >= 30);
  if (lines.some((l) => o.includes(l) || o.includes(l.slice(0, 45)))) return true;
  // Copia com pequenas mudancas: 3 ou mais sequencias de 6 palavras da instrucao na resposta.
  const words = normalize(systemPrompt).replace(/[^\p{L}\p{N}\s]/gu, ' ').split(/\s+/).filter(Boolean);
  const shingles = new Set<string>();
  for (let i = 0; i + 6 <= words.length; i++) shingles.add(words.slice(i, i + 6).join(' '));
  const ow = o.replace(/[^\p{L}\p{N}\s]/gu, ' ').split(/\s+/).filter(Boolean);
  let hits = 0;
  for (let i = 0; i + 6 <= ow.length; i++) if (shingles.has(ow.slice(i, i + 6).join(' ')) && ++hits >= 3) return true;
  return false;
}

/** Corta no fim de frase mais proximo antes do limite. */
function clip(text: string, max: number) {
  if (text.length <= max) return text;
  const cut = text.slice(0, max);
  const end = Math.max(cut.lastIndexOf('. '), cut.lastIndexOf('! '), cut.lastIndexOf('? '), cut.lastIndexOf('\n'));
  return (end > max * 0.5 ? cut.slice(0, end + 1) : cut.replace(/\s+\S*$/, '')).trim() + (end > max * 0.5 ? '' : '…');
}

/**
 * Filtro de saida, no servidor, sem outra chamada a IA. Barra: segredo, copia da instrucao interna, nomes internos e
 * mensagens tecnicas. Oculta: documentos, cartoes, e-mails e links para fora da loja. Limita o tamanho e tira markdown.
 */
export function checkOutput(raw: string, ctx: OutputContext): OutputCheck {
  const issues: string[] = [];
  let text = raw.replace(/[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F]/g, '').replace(ZERO_WIDTH, '').trim();
  if (!text) return { action: 'blocked', text: '', issues: ['empty'] };
  const secretFree = redactSecrets(text, ctx.knownSecrets);
  if (secretFree !== text) return { action: 'blocked', text: '', issues: ['secret'] };
  if (promptLeak(text, ctx.systemPrompt)) return { action: 'blocked', text: '', issues: ['prompt_leak'] };
  if (INTERNAL_MARKERS.test(normalize(text))) return { action: 'blocked', text: '', issues: ['internal'] };

  const before = text;
  text = text
    .replace(/```[\s\S]*?```/g, (m) => m.replace(/```\w*/g, '').trim())
    .replace(/\*\*(.+?)\*\*/g, '*$1*')
    .replace(/^#{1,6}\s+/gm, '')
    .replace(/\[([^\]]+)\]\((https?:\/\/[^)\s]+)\)/g, '$1: $2');
  if (text !== before) issues.push('format');
  const masked = redactPersonal(text);
  if (masked !== text) {
    issues.push('personal_data');
    text = masked;
  }
  text = text.replace(/\b(?:https?:\/\/|www\.)[^\s<>"')]+/gi, (url) => {
    let host = '';
    try {
      host = new URL(url.startsWith('www.') ? `https://${url}` : url).hostname.toLowerCase();
    } catch {
      host = '';
    }
    if (host && ctx.allowedHosts.has(host)) return url;
    issues.push('external_link');
    return '[link removido]';
  });
  // Dominios soltos (sem http) que nao sao da loja: "acesse evil.com".
  text = text.replace(/\b([a-z0-9-]+\.)+(com|net|org|io|br|xyz|ru|cn|info|biz|top|site|online|app|dev|me|co)(\/\S*)?\b/gi, (m, _a, _b, _c, offset: number, whole: string) => {
    if (whole.slice(Math.max(0, offset - 8), offset).match(/https?:\/\/$/)) return m;
    const host = m.split('/')[0]!.toLowerCase();
    if (ctx.allowedHosts.has(host) || [...ctx.allowedHosts].some((h) => h.endsWith(`.${host}`) || host.endsWith(`.${h}`))) return m;
    issues.push('external_link');
    return '[link removido]';
  });
  const max = ctx.maxLength ?? 1000;
  if (text.length > max) {
    text = clip(text, max);
    issues.push('too_long');
  }
  const meaningful = issues.filter((i) => i !== 'format');
  return { action: meaningful.length ? 'redacted' : 'ok', text, issues };
}
