# Meu site

## Assinaturas e autenticação

A API oferece três assinaturas recorrentes cobradas em reais:

| Plano | Renovação | Preço |
|---|---:|---:|
| `monthly` | 1 mês | R$ 5,00 |
| `quarterly` | 3 meses | R$ 10,00 |
| `semiannual` | 6 meses | R$ 20,00 |

O cadastro e o login são necessários para usar as ferramentas e associar pagamentos a uma conta. O checkout retorna um link do Mercado Pago; o backend atualiza a assinatura por notificações verificadas do provedor. Não há armazenamento de dados de cartão.

### Configuração local

1. Copie `.env.example` para `.env` e preencha `DB_PASSWORD` com a senha do PostgreSQL usada no Beekeeper.
2. Configure o PostgreSQL e gere um segredo JWT aleatório com pelo menos 32 caracteres. No PowerShell:

   ```powershell
   node -e "console.log(require('node:crypto').randomBytes(32).toString('hex'))"
   ```

3. Configure `PUTER_AUTH_TOKEN` para habilitar as ferramentas de IA no backend. Gere um segredo aleatório para `SEARXNG_SECRET`, que protege a instância de pesquisa:

   ```powershell
   node -e "console.log(require('node:crypto').randomBytes(32).toString('hex'))"
   ```

   Mantenha tokens e segredos apenas no `.env` local e nunca os envie ao navegador ou ao controle de versão.
4. Para pagamentos, configure credenciais de teste do Mercado Pago em `MERCADO_PAGO_ACCESS_TOKEN`, o segredo de Webhooks em `MERCADO_PAGO_WEBHOOK_SECRET` e uma URL de retorno HTTPS em `MERCADO_PAGO_BACK_URL`. Use credenciais de teste até validar o fluxo.
5. Aponte a URL de notificações Webhooks do Mercado Pago para `POST /webhooks/mercadopago` em um endereço HTTPS acessível pelo Mercado Pago. Se estiver desenvolvendo localmente, use um túnel HTTPS. Habilite os eventos de assinatura e pagamentos autorizados.
6. Inicie a instância SearXNG privada pelo Docker Compose, instale dependências, aplique as migrações e inicie a API:

   ```powershell
   docker compose up -d searxng
   pnpm install
   pnpm db:migrate
   pnpm dev
   ```

Para usar a mesma instância do Beekeeper Studio, configure no `.env` o host,
a porta, o banco, o usuário e a senha dessa conexão. Os padrões locais são
`localhost:5433`, banco `que-peixe-e-esse-db` e usuário `admin`; preencha
`DB_PASSWORD` com a senha usada no Beekeeper. A tabela de usuários é
`public.users`. O serviço `app` do Docker Compose também se conecta a essa
instância no host, em vez de iniciar um banco PostgreSQL separado.
O SearXNG é executado em um contêiner separado e a porta `8080` fica vinculada
somente a `127.0.0.1`; o backend no Compose se comunica com ele pela rede
interna. Ao rodar a API diretamente com `pnpm dev`, `FISH_SEARCH_URL` usa
`http://localhost:8080` por padrão, sem exigir essa variável no `.env`. Para
iniciar a aplicação e a pesquisa em conjunto na
VPS, use `docker compose up -d --build` após configurar o `.env`.

### Frontend

Os arquivos HTML, CSS, JavaScript e imagens do frontend mais recente ficam em
`public/` e são servidos pelo Express na mesma origem da API. Depois de iniciar
o backend, abra `http://localhost:3001`. A interface inclui identificação de
peixes, cálculo de litros, planejamento de fauna e busca de lojas próximas.
A interface permite criar conta, entrar, acompanhar o teste e iniciar ou
cancelar a assinatura. Como frontend e API usam a mesma origem, não é
necessário habilitar CORS para esse arranjo. O Dockerfile inclui os arquivos de
`public/` na imagem.

### Login, teste gratuito e acesso às ferramentas

É necessário criar uma conta e entrar antes de usar qualquer ferramenta. Cada
conta tem uma utilização gratuita de identificação de peixe e uma utilização
gratuita do cálculo de litros. Planejar fauna e buscar lojas próximas exigem
assinatura. Após o teste, as quatro ferramentas ficam disponíveis sem limite
enquanto houver uma assinatura autorizada com pagamento aprovado; uma
assinatura cancelada continua válida até o fim do período pago registrado.
O consumo do teste é registrado no backend por usuário e ferramenta.

Para aplicar a tabela de consumo no banco, execute `pnpm db:migrate` depois de
atualizar o projeto. O cadastro continua disponível mesmo sem credenciais de
pagamento, mas iniciar uma assinatura exige configurar Mercado Pago.

### Identificação de peixes

A foto é redimensionada no navegador e enviada ao backend, que a encaminha ao
serviço de IA do Puter para sugerir uma espécie. O token do Puter fica somente
no ambiente do servidor; o navegador não carrega o SDK nem chama o serviço
diretamente. Para espécies no catálogo local, a IA resume os cuidados
da ficha pesquisada. Para outras espécies, o backend pesquisa guias de
aquarismo em domínios confiáveis e a IA resume os trechos encontrados, sem
completar lacunas com informações não verificadas. Os links das fontes
consultadas são exibidos junto das recomendações. A pesquisa externa recebe o
nome científico sugerido, não a foto. A identificação e o resumo da IA podem
estar incorretos; confira a espécie e as fontes antes de seguir as orientações.
A interface informa que a imagem é processada por um serviço externo e orienta
a não enviar imagens com pessoas ou informações pessoais.

O catálogo inicial cobre Betta (`Betta splendens`) e Guppy
(`Poecilia reticulata`). Para outras espécies, o backend pesquisa via SearXNG
e mantém somente resultados HTTPS de Aquarium Co-Op, Seriously Fish,
Practical Fishkeeping, Fishkeeping World e The Spruce Pets. A resposta JSON
precisa estar habilitada em `searxng/settings.yml`. Configure
`FISH_SEARCH_URL` no `.env` somente se precisar substituir a URL padrão de
desenvolvimento; sem a instância, a aplicação informa que a pesquisa está
indisponível em vez de gerar recomendações sem fontes.

### Endpoints

- `GET /account/me` — requer autenticação; retorna estado da assinatura e usos restantes no teste.
- `POST /fish/identify` — requer autenticação; recebe uma imagem `image/jpeg` de até 2 MB, executa identificação e cuidados no backend e registra o uso gratuito somente após a operação ser concluída.
- `POST /tools/calculate-liters` — requer autenticação; recebe `{"length":50,"width":30,"height":30}` em centímetros e devolve o volume em litros.
- `POST /tools/plan-fauna` — requer autenticação e assinatura ativa; recebe `{"newSpecies":"Betta splendens","existingSpecies":["Corydoras paleatus"]}`.
- `POST /tools/find-stores` — requer autenticação e assinatura ativa; recebe `{"cep":"01001000"}` e devolve a URL de pesquisa do Google Maps.
- `POST /users` — cria uma conta com `name`, `email` e `password` (de 8 a 128 caracteres e até 72 bytes em UTF-8). A senha é armazenada com bcrypt; em caso de dados inválidos, a resposta inclui o campo e o motivo.
- `POST /sessions` — recebe `email` e `password`; retorna um token Bearer válido por uma hora.
- `POST /subscriptions/checkout` — requer `Authorization: Bearer <token>` e JSON como `{"plan":"quarterly"}`; retorna `checkoutUrl`.
- `GET /subscriptions/me` — requer autenticação; mostra o estado local da assinatura.
- Se o Mercado Pago recusar o checkout, a resposta `502` informa o status HTTP e o código de erro do provedor, sem expor a mensagem bruta.
- `POST /subscriptions/cancel` — requer autenticação; cancela a renovação no Mercado Pago e conserva a data final do período pago.
- `POST /webhooks/mercadopago` — endpoint público para notificações; a assinatura HMAC é verificada antes de consultar o recurso diretamente na API do Mercado Pago.

Uma assinatura em andamento impede criar outra até que o período vigente termine. Antes de ativar em produção, ainda é necessário definir a política de acesso durante falhas de renovação e validar criação, renovação e cancelamento com credenciais sandbox.
