# Workspace Database

Aplicação de gerenciamento com uma única visão (`Database`), frontend estático para GitHub Pages e backend Google Apps Script ligado a uma planilha Google Sheets.

## Estrutura

```text
site-backlog/
├── index.html
├── styles.css
├── app.js
├── backend/
│   └── Code.gs
├── README.md
└── .nojekyll
```

## 1. Preparar a planilha

### Aba `Database`
Crie ou confirme uma aba chamada **Database**. A linha 1 deve conter estes nomes exatos (em qualquer ordem):

```text
Categoria | Descrição | Projeto | Status | Observação | Data conclusão | Recebedor | Preço total
```

`Projeto` deve ser uma caixa de seleção (ou valor booleano). Um status vazio é apresentado como **Aberto**. Linhas sem Categoria e sem Descrição são ignoradas.

### Aba `Atalhos`
A aba **Atalhos** armazena os botões de atalho rápido configuráveis:

```text
Nome-Button | Categorias-Filtradas | Apenas-Projetos | Status-Selecionados | Categorias-Duplicadas | Colunas | Ativar-Atalho
```
- `Nome-Button`: Nome do botão do atalho (ex.: *Compra*, *Teste*, *Backlog*, *Projetos*).
- `Categorias-Filtradas`: Lista de categorias separadas por vírgula (ou vazio para todas).
- `Apenas-Projetos`: `TRUE`, `FALSE` (oculta projetos) ou vazio (padrão do site).
- `Status-Selecionados`: Status separados por vírgula (ex.: `Aberto` ou `Aberto, Resolvido`).
- `Categorias-Duplicadas`: `TRUE` para ativar agrupamento "Não mostrar Categoria duplicadas" ou vazio/`FALSE`.
- `Colunas`: Colunas visíveis separadas por vírgula (ou vazio para o padrão).
- `Ativar-Atalho`: `TRUE` para exibir na barra principal ou `FALSE` para colocar na lista de atalhos inativos.

Caso a aba **Atalhos** ainda não exista na planilha, o backend criará a aba automaticamente com os cabeçalhos na primeira operação de salvamento.

---

## 2. Publicar o backend Apps Script (IMPORTANTE)

1. Abra a planilha e escolha **Extensões → Apps Script**.
2. Copie o conteúdo de [`backend/Code.gs`](backend/Code.gs) para o editor Apps Script (substituindo o código anterior).
3. Salve o projeto.
4. Escolha **Implantar → Gerenciar implantações**.
5. Clique no ícone de lápis (**Editar**), selecione **Versão: Nova versão**, e clique em **Implantar**.
   > **Nota essencial:** No Google Apps Script, alterações feitas no código só entram em vigor na URL `/exec` depois que você salva uma **Nova versão** em Gerenciar implantações.
6. A URL do Web App termina em `/exec` e permanece a mesma.

---

## 3. Publicar o frontend no GitHub Pages

1. Adicione os arquivos `index.html`, `styles.css`, `app.js` e `.nojekyll` à raiz do repositório.
2. No GitHub, abra **Settings → Pages**.
3. Em **Build and deployment**, selecione **Deploy from a branch**, escolha a branch e a pasta raiz (`/`), e salve.
4. Aguarde a publicação indicada pelo GitHub Pages.
5. A URL do Web App já está definida na constante `BACKEND_URL`, no início de `app.js`.

---

## Recursos e Funcionalidades

- **Rolagem fluida com primeira coluna congelada e cabeçalho fixo:** Rolagem vertical e horizontal natural da página (sem barras internas forçadas), mantendo a primeira coluna fixa à esquerda (`position: sticky; left: 0`) e o cabeçalho fixo no topo com fundos opacos nos temas claro e escuro.
- **Edição somente com Duplo Clique (`dblclick`):** Todas as células da tabela operam inicialmente em modo de leitura rígido (evitando toques acidentais durante a rolagem). O usuário dá duplo clique para entrar em modo de edição, permitindo então o uso normal do menu nativo do sistema/navegador (copiar, colar, recortar).
- **Alça de expansão de mensagem nas células:** Células de texto possuem uma discreta alça no canto inferior direito (`⤡`) que permite arrastar para expandir a área de visualização sem acionar menus ou seleção.
- **Menu de contexto (Desktop & Mobile):** Botão direito no desktop ou pressionar e segurar (long press) no mobile destaca a linha em foco e abre o menu de contexto:
  - *Selecionar*: Ativa a seleção múltipla, com barra flutuante para copiar linhas formatadas com cabeçalhos para o clipboard ou limpar seleção.
  - *Duplicar linha*: Duplica a linha como uma nova entrada pendente pronta para edição.
- **Barra de Atalhos Rápidos:** Lê os atalhos ativos (como *Compra* e *Teste*) da aba `Atalhos` da planilha e os renderiza na barra superior, permitindo aplicar instantaneamente filtros de categoria, projetos, status e colunas. Inclui menu centralizado para "Atalhos inativos" e formulário para criar, editar e excluir atalhos.
- **Contador inteligente de alterações:** Os botões *Salvar alterações* e *Cancelar* contabilizam linhas únicas da Database modificadas/criadas + 1 unidade por atalho criado/editado/ativado/excluído.
- **Modal de conflito de Categoria:** Ao editar a categoria de uma tarefa compartilhada com outras, permite escolher entre alterar apenas aquela linha ou todas as linhas correspondentes (atualizando os atalhos vinculados).
- **Confirmação ao Salvar:** Modal de confirmação inteligente caso haja mais de 1 linha modificada antes de enviar para a planilha.
- **Autocompletar de Categoria:** Sugestões dinâmicas de categorias existentes no modal "Adicionar tarefa", sem preenchimento involuntário.
