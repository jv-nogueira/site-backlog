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

### Aba `Atalhos` (Opcional - Criada automaticamente pelo backend)
Se desejar pré-configurar atalhos diretamente na planilha, crie uma aba chamada **Atalhos** com os cabeçalhos:

```text
Nome-Button | Categorias-Filtradas | Apenas-Projetos | Status-Selecionados | Categorias-Duplicadas | Colunas | Ativar-Atalho
```
- `Nome-Button`: Nome do botão do atalho (ex.: *Backlog*, *Projetos*, *Marketing*).
- `Categorias-Filtradas`: Lista de categorias separadas por vírgula (ou vazio para todas).
- `Apenas-Projetos`: `TRUE`, `FALSE` (oculta projetos) ou vazio (padrão do site).
- `Status-Selecionados`: Status separados por vírgula (ex.: `Aberto` ou `Aberto, Resolvido`).
- `Categorias-Duplicadas`: `TRUE` para ativar agrupamento "Não mostrar Categoria duplicadas" ou vazio.
- `Colunas`: Colunas visíveis separadas por vírgula (ou vazio para o padrão).
- `Ativar-Atalho`: `TRUE` para exibir na barra principal ou `FALSE` para colocar na lista recolhida de atalhos inativos.

Caso a aba **Atalhos** ainda não exista na planilha, o backend criará a aba automaticamente com os cabeçalhos na primeira operação de salvamento.

---

## 2. Publicar o backend Apps Script

1. Abra a planilha e escolha **Extensões → Apps Script**.
2. Copie o conteúdo de [`backend/Code.gs`](backend/Code.gs) para o editor Apps Script (o arquivo pode ser chamado `Code.gs`).
3. Salve o projeto. Como ele foi criado a partir da planilha, `getActiveSpreadsheet()` aponta para esse Workspace.
4. Escolha **Implantar → Gerenciar implantações**.
   - Se for a primeira vez: **Nova implantação → App da Web**.
   - Se estiver atualizando uma implantação existente: Clique no ícone de lápis (**Editar**), selecione **Versão: Nova versão**, e clique em **Implantar**. **Importante:** Sempre que o arquivo `Code.gs` for alterado, é obrigatório gerar uma **Nova versão** para que o Google Apps Script atualize o código em produção na URL `/exec`.
5. Selecione **Executar como: eu** e escolha quem pode acessar o Web App (ex.: *Qualquer pessoa*). Confirme a implantação e autorize o acesso solicitado.
6. Copie a URL de implantação terminada em `/exec`.

O Apps Script não permite configurar livremente cabeçalhos CORS para uma resposta de `ContentService`. Por isso, a leitura usa JSONP e as gravações usam um formulário direcionado a um iframe oculto, que recebe uma confirmação via `postMessage`. A aplicação valida a origem da resposta do iframe/Apps Script e um nonce de requisição.

---

## 3. Publicar o frontend no GitHub Pages

1. Adicione os arquivos `index.html`, `styles.css`, `app.js` e `.nojekyll` à raiz do repositório.
2. No GitHub, abra **Settings → Pages**.
3. Em **Build and deployment**, selecione **Deploy from a branch**, escolha a branch e a pasta raiz (`/`), e salve.
4. Aguarde a publicação indicada pelo GitHub Pages.
5. A URL do Web App já está definida na constante `BACKEND_URL`, no início de `app.js`. Para trocar de backend, edite essa constante, publique as alterações no GitHub Pages e recarregue o site.

Não é necessária etapa de build. Para testar localmente, sirva a raiz com qualquer servidor HTTP estático. A integração não deve ser testada abrindo o HTML com `file://`.

---

## Recursos e Funcionalidades

- **Coluna congelada e cabeçalho fixo (Sticky):** A primeira coluna e o cabeçalho `thead` permanecem fixos durante a rolagem horizontal e vertical, com fundo opaco em ambos os modos (claro e escuro).
- **Redimensionamento de colunas:** Ajuste a largura de qualquer coluna arrastando a borda direita do seu cabeçalho (suporta mouse e touch).
- **Conteúdo rígido nas células:** Células sem scroll interno indesejado, permitindo rolagem fluida e sem travar o toque em dispositivos móveis.
- **Atalhos Rápidos Configuráveis:** Barra superior de atalhos rápidos integrada com a aba `Atalhos` da planilha. Permite criar, editar, ativar/desativar e excluir atalhos. As mudanças são aplicadas no frontend e salvas na planilha via "Salvar alterações".
- **Contador inteligente de alterações:** Os botões *Salvar alterações* e *Cancelar* contabilizam linhas únicas da Database modificadas/criadas + 1 unidade por atalho criado/editado/ativado/excluído.
- **Modal de alteração de Categoria:** Ao editar a categoria de uma linha que compartilha a mesma categoria com outras, é exibida a opção de alterar apenas naquela linha ou em todas as linhas correspondentes (atualizando inclusive atalhos vinculados).
- **Confirmação ao Salvar:** Modal de confirmação inteligente caso haja mais de 1 linha modificada antes de enviar para a planilha.
- **Menu de contexto (Desktop e Mobile):** Clique com botão direito ou mantenha pressionado (long press no mobile) em uma linha para abrir o menu com as opções:
  - *Selecionar*: Ativa a seleção múltipla de linhas, com barra flutuante para copiar dados tabulados com cabeçalhos para o clipboard ou limpar seleção.
  - *Duplicar linha*: Clona a linha como uma nova entrada pendente pronta para edição.
- **Autocompletar de Categoria:** Sugestões dinâmicas de categorias existentes no modal "Adicionar tarefa", sem preenchimento involuntário.
- **Filtros avançados e Ordenação:** Filtros por coluna estilo planilha (Google Sheets), busca em tempo real, status e agrupamento de duplicadas.
