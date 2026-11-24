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

Crie ou confirme uma aba chamada **Database**. A linha 1 deve conter estes nomes exatos (em qualquer ordem):

```text
Categoria | Descrição | Projeto | Status | Observação | Data conclusão | Recebedor | Preço total
```

`Projeto` deve ser uma caixa de seleção (ou valor booleano). Um status vazio é apresentado como **Aberto**. Linhas sem Categoria e sem Descrição são ignoradas.

## 2. Publicar o backend Apps Script

1. Abra a planilha e escolha **Extensões → Apps Script**.
2. Copie o conteúdo de [`backend/Code.gs`](backend/Code.gs) para o editor Apps Script (o arquivo pode ser chamado `Code.gs`).
3. Salve o projeto. Como ele foi criado a partir da planilha, `getActiveSpreadsheet()` aponta para esse Workspace.
4. Escolha **Implantar → Nova implantação → App da Web**.
5. Selecione **Executar como: eu** e escolha quem pode acessar o Web App. Confirme a implantação e autorize o acesso solicitado.
6. Copie a URL de implantação terminada em `/exec`.

O Apps Script não permite configurar livremente cabeçalhos CORS para uma resposta de `ContentService`. Por isso, a leitura usa JSONP e as gravações usam um formulário direcionado a um iframe oculto, que recebe uma confirmação via `postMessage`. A aplicação valida a origem da resposta do iframe/Apps Script e um nonce de requisição.

**Atenção ao acesso:** um Web App publicado para acesso amplo pode permitir que qualquer pessoa que conheça sua URL consulte e altere a planilha, executando com as permissões do proprietário. Restrinja o acesso na implantação a usuários da sua organização/conta sempre que possível. O frontend não é uma camada de autenticação.

## 3. Publicar o frontend no GitHub Pages

1. Adicione os arquivos `index.html`, `styles.css`, `app.js` e `.nojekyll` à raiz do repositório.
2. No GitHub, abra **Settings → Pages**.
3. Em **Build and deployment**, selecione **Deploy from a branch**, escolha a branch e a pasta raiz (`/`), e salve.
4. Aguarde a publicação indicada pelo GitHub Pages.
5. A URL do Web App já está definida na constante `BACKEND_URL`, no início de `app.js`. Para trocar de backend, edite essa constante, publique as alterações no GitHub Pages e recarregue o site.

Não é necessária etapa de build. Para testar localmente, sirva a raiz com qualquer servidor HTTP estático. A integração não deve ser testada abrindo o HTML com `file://`.

## Recursos

- Tabela dinâmica baseada nos nomes exatos dos oito cabeçalhos, independente da posição das colunas.
- Colunas visíveis inicialmente: Categoria, Descrição, Recebedor e Preço total. A seleção de colunas também é lembrada no navegador.
- Filtros de status, somente projetos, busca e agrupamento expansível de Categorias duplicadas.
- Criação, edição em linha, propagação de mudança de Categoria para as tarefas que compartilhavam o nome anterior e atualização de Data conclusão ao mudar Status.
- **Salvar alterações** aplica uma única transação lógica; **Cancelar** descarta as edições locais. O backend usa lock e valida a versão das linhas antes de gravar, recusando alterações conflitantes.
- Novas tarefas são inseridas a partir da linha 2, logo abaixo dos cabeçalhos. Uma criação como Resolvido recebe data de conclusão automaticamente.

## Implantação após alterações

Depois de editar o Apps Script, crie uma nova versão da implantação em **Implantar → Gerenciar implantações → Editar → Nova versão**. A URL `/exec` normalmente permanece a mesma.
