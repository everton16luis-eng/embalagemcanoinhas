"""Gera deploy/typebot/fluxo-atendimento.json para importar no Typebot 3.19 (docs/11-typebot.md, passo 9).

Formato conferido no codigo-fonte oficial (tag v3.19.1, 14/11/2026): typebot v6 (version "6.1"), events[start],
groups[{id,title,graphCoordinates,blocks}], edges[{id,from:{eventId}|{blockId,itemId?},to:{groupId}}],
bloco de texto {type:"text", content:{richText}}, botoes {type:"choice input", items:[{id,content,value?}]},
texto livre {type:"text input", options:{variableId, labels}}. Tema e configuracoes aceitam objeto vazio.

O fluxo nao traz preco, horario, endereco nem prazo: esses dados vem da loja pelos valores reservados dos botoes
(pedido, orcamento, horario, atendente), que a loja atende com o que esta cadastrado no painel.

Uso: python deploy/typebot/gerar-fluxo.py
"""

import json
from pathlib import Path

SITE = "https://embalagemcanoinhas.com.br"

edges = []
groups = []


def p(*runs):
    """Paragrafo do editor de texto do Typebot. Cada run: texto ou (texto, {"bold": True})."""
    children = [{"text": r} if isinstance(r, str) else {"text": r[0], **r[1]} for r in runs]
    return {"type": "p", "children": children}


def text(bid, *paragraphs):
    return {"id": bid, "type": "text", "content": {"richText": list(paragraphs)}}


def link(source, group_id):
    eid = f"e-{len(edges) + 1:02d}"
    edges.append({"id": eid, "from": source, "to": {"groupId": group_id}})
    return eid


def choice(bid, options):
    """options: (item_id, rotulo, valor reservado ou None, grupo de destino ou None)."""
    items = []
    for iid, label, value, target in options:
        item = {"id": iid, "content": label}
        if value:
            item["value"] = value
        if target:
            item["outgoingEdgeId"] = link({"blockId": bid, "itemId": iid}, target)
        items.append(item)
    return {"id": bid, "type": "choice input", "items": items}


def group(gid, title, x, y, blocks):
    groups.append({"id": gid, "title": title, "graphCoordinates": {"x": x, "y": y}, "blocks": blocks})


# Inicio -> boas-vindas -> menu
start_edge = link({"eventId": "ev-inicio"}, "g-boas-vindas")
welcome_last = text("b-boas-vindas-2", p("Aqui é o atendimento da loja de embalagens e artigos para confeitaria."))
welcome_last["outgoingEdgeId"] = link({"blockId": "b-boas-vindas-2"}, "g-menu")
group(
    "g-boas-vindas",
    "Boas-vindas",
    0,
    0,
    [text("b-boas-vindas-1", p("Olá! Que bom ter você por aqui.")), welcome_last],
)

group(
    "g-menu",
    "Menu",
    400,
    0,
    [
        text("b-menu-1", p("Como posso ajudar? Escolha uma opção:")),
        choice(
            "b-menu-2",
            [
                ("i-menu-produto", "Procurar um produto", None, "g-produto"),
                ("i-menu-pedido", "Acompanhar pedido", "pedido", None),
                ("i-menu-orcamento", "Pedir orçamento", "orcamento", None),
                ("i-menu-quantidade", "Compras em quantidade", None, "g-quantidade"),
                ("i-menu-horario", "Horário e endereço", "horario", None),
                ("i-menu-atendente", "Falar com atendente", "atendente", None),
            ],
        ),
    ],
)

product_last = text(
    "b-produto-3",
    p("Veja fotos, preços e estoque de ", ("{{produto}}", {"bold": True}), " na loja virtual. É só usar a busca no topo da página:"),
    p(SITE),
)
product_last["outgoingEdgeId"] = link({"blockId": "b-produto-3"}, "g-mais")
group(
    "g-produto",
    "Procurar um produto",
    800,
    -250,
    [
        text("b-produto-1", p("Qual produto você procura? Escreva o nome, por exemplo: copo 300 ml, forminha nº 5 ou caixa para bolo.")),
        {
            "id": "b-produto-2",
            "type": "text input",
            "options": {"variableId": "v-produto", "labels": {"placeholder": "Nome do produto", "button": "Enviar"}},
        },
        product_last,
    ],
)

group(
    "g-quantidade",
    "Compras em quantidade",
    800,
    150,
    [
        text(
            "b-quantidade-1",
            p("Atendemos confeitarias, padarias e outros negócios. Muitos produtos ficam mais baratos por unidade conforme a quantidade, e as faixas de preço aparecem na página de cada produto."),
        ),
        text("b-quantidade-2", p("Para pedidos grandes ou itens sob encomenda, peça um orçamento ou fale com um atendente.")),
        choice(
            "b-quantidade-3",
            [
                ("i-qtd-orcamento", "Pedir orçamento", "orcamento", None),
                ("i-qtd-atendente", "Falar com atendente", "atendente", None),
                ("i-qtd-menu", "Voltar ao menu", None, "g-menu"),
            ],
        ),
    ],
)

group(
    "g-mais",
    "Mais alguma coisa",
    1200,
    -250,
    [
        text("b-mais-1", p("Posso ajudar em mais alguma coisa?")),
        choice(
            "b-mais-2",
            [
                ("i-mais-menu", "Ver o menu", None, "g-menu"),
                ("i-mais-atendente", "Falar com atendente", "atendente", None),
                ("i-mais-fim", "Encerrar", None, "g-fim"),
            ],
        ),
    ],
)

group(
    "g-fim",
    "Fim",
    1600,
    -250,
    [text("b-fim-1", p("Obrigado pelo contato! Quando precisar, é só mandar uma mensagem."))],
)

flow = {
    "version": "6.1",
    "name": "Atendimento da loja (WhatsApp)",
    "icon": None,
    "folderId": None,
    "events": [{"id": "ev-inicio", "type": "start", "graphCoordinates": {"x": -300, "y": 0}, "outgoingEdgeId": start_edge}],
    "groups": groups,
    "edges": edges,
    "variables": [{"id": "v-nome", "name": "nome"}, {"id": "v-produto", "name": "produto"}],
    "theme": {},
    "selectedThemeTemplateId": None,
    "settings": {
        "general": {"systemMessages": {"invalidMessage": "Não entendi. Toque em uma das opções ou escreva o nome dela."}},
        "metadata": {"title": "Atendimento da loja"},
    },
}

# Conferencias: ids unicos, arestas apontam para o que existe e cada saida tem a aresta correspondente.
ids = [g["id"] for g in groups] + [b["id"] for g in groups for b in g["blocks"]]
ids += [i["id"] for g in groups for b in g["blocks"] for i in b.get("items", [])] + [e["id"] for e in edges]
assert len(ids) == len(set(ids)), "id repetido"
group_ids = {g["id"] for g in groups}
block_ids = {b["id"] for g in groups for b in g["blocks"]}
for e in edges:
    assert e["to"]["groupId"] in group_ids, e
    src = e["from"]
    assert src.get("eventId") == "ev-inicio" or src.get("blockId") in block_ids, e
outgoing = {flow["events"][0]["outgoingEdgeId"]}
for g in groups:
    for b in g["blocks"]:
        if "outgoingEdgeId" in b:
            outgoing.add(b["outgoingEdgeId"])
        for i in b.get("items", []):
            assert len(i["content"]) <= 24, i  # titulo de lista do WhatsApp
            if "outgoingEdgeId" in i:
                outgoing.add(i["outgoingEdgeId"])
            else:
                assert i.get("value") in {"pedido", "orcamento", "horario", "atendente", "menu"}, i
assert outgoing == {e["id"] for e in edges}, "aresta sem saida ou saida sem aresta"

out = Path(__file__).with_name("fluxo-atendimento.json")
out.write_text(json.dumps(flow, ensure_ascii=False, indent=2) + "\n", encoding="utf-8")
print(f"{out.name}: {len(groups)} grupos, {len(edges)} ligações")
