const dominiosFontesCuidados = [
  'aquariumcoop.com',
  'seriouslyfish.com',
  'practicalfishkeeping.co.uk',
  'fishkeepingworld.com',
  'thesprucepets.com',
];

function renderizarFontesCuidados(sources) {
  const list = document.querySelector('.cuidados-fontes');
  list.replaceChildren();

  for (const source of sources) {
    let url;
    try {
      url = new URL(source.url);
    } catch {
      continue;
    }
    const trusted = dominiosFontesCuidados.some(
      (domain) =>
        url.hostname === domain || url.hostname.endsWith(`.${domain}`),
    );
    if (
      url.protocol !== 'https:' ||
      url.username ||
      url.password ||
      url.port ||
      !trusted
    ) {
      continue;
    }

    const item = document.createElement('li');
    const link = document.createElement('a');
    link.href = url.href;
    link.textContent = source.title;
    link.target = '_blank';
    link.rel = 'noopener noreferrer';
    item.append(link);
    list.append(item);
  }
}

let notificationTimeout;

function showNotification(message) {
  const notification = document.querySelector('.notification-toast');
  document.querySelector('.notification-toast-message').textContent = message;
  notification.hidden = false;
  clearTimeout(notificationTimeout);
  notificationTimeout = setTimeout(() => {
    notification.hidden = true;
  }, 8000);
}

function redimensionarImagem(arquivo) {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onerror = () =>
      reject(new Error('Não foi possível ler a imagem selecionada.'));
    reader.onload = () => {
      const imagem = new Image();
      imagem.onerror = () =>
        reject(new Error('O arquivo selecionado não é uma imagem válida.'));
      imagem.onload = () => {
        const escala = Math.min(1, 800 / imagem.width, 800 / imagem.height);
        const canvas = document.createElement('canvas');
        canvas.width = Math.round(imagem.width * escala);
        canvas.height = Math.round(imagem.height * escala);
        const contexto = canvas.getContext('2d');
        if (!contexto) {
          reject(new Error('Não foi possível preparar a imagem.'));
          return;
        }
        contexto.drawImage(imagem, 0, 0, canvas.width, canvas.height);
        canvas.toBlob(
          (blob) => {
            if (!blob) {
              reject(new Error('Não foi possível compactar a imagem.'));
              return;
            }
            resolve(
              new File([blob], 'fish-image.jpg', {
                type: 'image/jpeg',
              }),
            );
          },
          'image/jpeg',
          0.7,
        );
      };
      imagem.src = reader.result;
    };
    reader.readAsDataURL(arquivo);
  });
}

async function lerRespostaApi(resposta) {
  const corpo = await resposta.text();
  if (!corpo.trim()) {
    if (!resposta.ok) {
      return {};
    }
    throw new Error(
      `A API respondeu sem conteúdo (HTTP ${resposta.status}). Confirme que o backend atualizado está em execução.`,
    );
  }
  try {
    return JSON.parse(corpo);
  } catch {
    if (!resposta.ok) {
      return {};
    }
    throw new Error(
      `A API retornou uma resposta inválida (HTTP ${resposta.status}). Confirme que o backend atualizado está em execução.`,
    );
  }
}

function setAccountMessage(message, type = 'info') {
  const notification = document.querySelector('.conta-mensagem');
  notification.textContent = message;
  notification.dataset.type = type;
}

function showAccountForm(formName, { clearMessage = true } = {}) {
  const isRegister = formName === 'register';
  document.querySelector('#registerPanel').hidden = !isRegister;
  document.querySelector('#loginPanel').hidden = isRegister;

  const registerTab = document.querySelector('#tabCadastro');
  const loginTab = document.querySelector('#tabLogin');
  registerTab.classList.toggle('active', isRegister);
  loginTab.classList.toggle('active', !isRegister);
  registerTab.setAttribute('aria-selected', String(isRegister));
  loginTab.setAttribute('aria-selected', String(!isRegister));

  if (clearMessage) {
    setAccountMessage('');
  }
}

function clearAccount() {
  sessionStorage.removeItem('accessToken');
  sessionStorage.removeItem('accountUser');
  document.querySelector('#registerForm').reset();
  document.querySelector('#loginForm').reset();
  document.querySelector('.conta-boas-vindas').textContent = '';
  document.querySelector('.conta-assinatura').textContent = '';
  document.querySelector('.conta-teste').textContent = '';
  document.querySelector('.conta-acoes').hidden = false;
  document.querySelector('.conta-formularios').hidden = false;
  document.querySelector('.conta-logada').hidden = true;
  showAccountForm('login', { clearMessage: false });
}

async function apiRequest(path, options = {}) {
  const headers = new Headers(options.headers);
  const token = sessionStorage.getItem('accessToken');
  if (token) {
    headers.set('Authorization', `Bearer ${token}`);
  }
  if (options.body && !headers.has('Content-Type')) {
    headers.set('Content-Type', 'application/json');
  }

  let response;
  try {
    response = await fetch(path, { ...options, headers });
  } catch (cause) {
    const error = new Error(
      'Não foi possível conectar ao servidor. Verifique se o backend está em execução e tente novamente.',
      { cause },
    );
    showNotification(error.message);
    throw error;
  }

  let data;
  try {
    data = await lerRespostaApi(response);
  } catch (error) {
    showNotification(error.message);
    throw error;
  }

  if (!response.ok) {
    if (response.status === 401 && token) {
      clearAccount();
    }
    const method = (options.method || 'GET').toUpperCase();
    const message =
      data?.message ||
      (response.status === 405
        ? `O servidor recusou ${method} ${path} (HTTP 405). A chamada pode estar chegando ao servidor do frontend ou a um backend desatualizado. Use o frontend servido pelo backend atualizado e reinicie/reconstrua o backend.`
        : `Erro HTTP ${response.status}.`);
    const error = new Error(message);
    error.status = response.status;
    showNotification(error.message);
    throw error;
  }
  return data;
}

function renderAccount(account, { loginCompleted = false } = {}) {
  document.querySelector('.conta-acoes').hidden = true;
  document.querySelector('.conta-formularios').hidden = true;
  document.querySelector('.conta-logada').hidden = false;
  document.querySelector('.conta-boas-vindas').textContent =
    `Olá, ${account.user.name}.`;
  if (loginCompleted) {
    setAccountMessage(
      account.subscriptionActive
        ? `Login concluído! Obrigado por confiar no nosso trabalho, ${account.user.name}.`
        : `Login concluído! Bem-vindo, ${account.user.name}.`,
      'success',
    );
  }

  const subscriptionStatus = document.querySelector('.conta-assinatura');
  const cancelButton = document.querySelector('.cancelar-assinatura');
  const checkoutButton = document.querySelector('.iniciar-checkout');
  if (account.subscriptionActive) {
    const subscription = account.subscription;
    const endDate = subscription.currentPeriodEnd
      ? ` Acesso até ${new Date(subscription.currentPeriodEnd).toLocaleDateString('pt-BR')}.`
      : '';
    subscriptionStatus.textContent = `Assinatura ativa.${endDate}`;
    cancelButton.hidden =
      subscription.status !== 'authorized' || subscription.cancelAtPeriodEnd;
    checkoutButton.hidden = true;
  } else if (account.subscription?.status === 'pending') {
    subscriptionStatus.textContent =
      'Pagamento aguardando confirmação do Mercado Pago.';
    cancelButton.hidden = !account.subscription.hasProviderSubscription;
    checkoutButton.hidden = true;
  } else {
    subscriptionStatus.textContent =
      'Sem assinatura ativa. Assine para liberar todas as ferramentas sem limite.';
    cancelButton.hidden = true;
    checkoutButton.hidden = false;
  }

  const fishRemaining = account.tools['identify-fish'].remaining;
  const litersRemaining = account.tools['calculate-liters'].remaining;
  document.querySelector('.conta-teste').textContent =
    account.subscriptionActive
      ? 'Todas as ferramentas estão liberadas sem limite.'
      : `Teste disponível: ${fishRemaining} identificação(ões) e ${litersRemaining} cálculo(s) de litros. Planejar fauna e lojas próximas exigem assinatura.`;
}

async function loadAccount({ loginCompleted = false } = {}) {
  if (!sessionStorage.getItem('accessToken')) {
    return;
  }
  try {
    const account = await apiRequest('/account/me');
    renderAccount(account, { loginCompleted });
  } catch (error) {
    setAccountMessage(error.message);
  }
}

async function registerAccount(event) {
  event.preventDefault();
  const form = event.currentTarget;
  const user = Object.fromEntries(new FormData(form).entries());
  try {
    await apiRequest('/users', {
      method: 'POST',
      body: JSON.stringify(user),
    });
    document.querySelector('#loginEmail').value = user.email;
    form.reset();
    showAccountForm('login', { clearMessage: false });
    setAccountMessage(
      'Cadastro realizado com sucesso! Agora entre com seu e-mail e senha.',
      'success',
    );
    document.querySelector('#loginPassword').focus();
  } catch (error) {
    setAccountMessage(error.message);
  }
}

async function loginAccount(event) {
  event.preventDefault();
  const form = event.currentTarget;
  const credentials = Object.fromEntries(new FormData(form).entries());
  try {
    const session = await apiRequest('/sessions', {
      method: 'POST',
      body: JSON.stringify(credentials),
    });
    sessionStorage.setItem('accessToken', session.token);
    sessionStorage.setItem('accountUser', JSON.stringify(session.user));
    form.reset();
    await loadAccount({ loginCompleted: true });
  } catch (error) {
    setAccountMessage(error.message);
  }
}

async function startSubscriptionCheckout() {
  try {
    const { checkoutUrl } = await apiRequest('/subscriptions/checkout', {
      method: 'POST',
      body: JSON.stringify({
        plan: document.querySelector('#planSelect').value,
      }),
    });
    window.location.assign(checkoutUrl);
  } catch (error) {
    setAccountMessage(error.message);
  }
}

async function cancelSubscription() {
  try {
    const result = await apiRequest('/subscriptions/cancel', {
      method: 'POST',
    });
    await loadAccount();
    setAccountMessage(
      result.accessUntil
        ? `Renovação cancelada. O acesso permanece até ${new Date(result.accessUntil).toLocaleDateString('pt-BR')}.`
        : 'Renovação cancelada.',
    );
  } catch (error) {
    setAccountMessage(error.message);
  }
}

const CHAVE_ESTADO_PLANEJADOR = 'aquarista-planejador-v1';
let especieIdentificada = '';

function salvarEstadoPlanejador() {
  const estado = {
    especie: especieIdentificada,
    cuidados: document.querySelector('.cuidados').textContent,
    fontes: [...document.querySelectorAll('.cuidados-fontes a')].map(
      (link) => ({ title: link.textContent, url: link.href }),
    ),
    peixesExistentes: [...document.querySelectorAll('.peixe-existente')].map(
      (campo) => campo.value,
    ),
    analise: document.querySelector('.planejador-resultado').textContent,
  };

  try {
    localStorage.setItem(CHAVE_ESTADO_PLANEJADOR, JSON.stringify(estado));
    return true;
  } catch (erro) {
    console.error('Não foi possível salvar os dados do planejador:', erro);
    document.querySelector('.planejador-status').textContent =
      'Os dados foram usados nesta página, mas não puderam ser salvos neste navegador.';
    return false;
  }
}

function restaurarEstadoPlanejador() {
  try {
    const estadoSalvo = localStorage.getItem(CHAVE_ESTADO_PLANEJADOR);
    if (!estadoSalvo) {
      return;
    }

    const estado = JSON.parse(estadoSalvo);
    if (!estado || typeof estado !== 'object') {
      throw new Error('Os dados salvos do planejador estão inválidos.');
    }

    if (typeof estado.especie === 'string' && estado.especie.trim()) {
      especieIdentificada = estado.especie;
      document.querySelector('.especie').textContent = estado.especie;
      document.querySelector('.planejador-especie').textContent =
        estado.especie;
    }
    if (typeof estado.cuidados === 'string') {
      document.querySelector('.cuidados').textContent = estado.cuidados;
    }
    if (Array.isArray(estado.fontes)) {
      renderizarFontesCuidados(estado.fontes);
    }
    if (Array.isArray(estado.peixesExistentes)) {
      document.querySelectorAll('.peixe-existente').forEach((campo, indice) => {
        const peixe = estado.peixesExistentes[indice];
        if (typeof peixe === 'string') {
          campo.value = peixe;
        }
      });
    }
    if (typeof estado.analise === 'string') {
      document.querySelector('.planejador-resultado').textContent =
        estado.analise;
    }
  } catch (erro) {
    console.error('Não foi possível restaurar os dados do planejador:', erro);
    document.querySelector('.planejador-status').textContent =
      'Não foi possível recuperar os dados salvos do planejador. Você pode continuar com uma nova análise.';
  }
}

async function lerFoto() {
  const inputFoto = document.querySelector('.foto');
  const txtEspecie = document.querySelector('.especie');
  const txtCuidados = document.querySelector('.cuidados');
  const statusMessage = document.querySelector('.status-message');
  const arquivoImagem = inputFoto.files?.[0];

  statusMessage.textContent = '';
  document.querySelector('.notification-toast').hidden = true;
  txtEspecie.textContent = '';
  txtCuidados.textContent = '';
  renderizarFontesCuidados([]);
  especieIdentificada = '';
  document.querySelector('.planejador-especie').textContent =
    'Nenhum peixe identificado ainda.';
  document.querySelector('.planejador-resultado').textContent = '';
  salvarEstadoPlanejador();

  if (!arquivoImagem) {
    statusMessage.textContent =
      'Por favor, selecione uma imagem para identificar o peixe.';
    showNotification(statusMessage.textContent);
    return;
  }
  if (!arquivoImagem.type.startsWith('image/')) {
    statusMessage.textContent = 'O arquivo precisa ser uma imagem.';
    showNotification(statusMessage.textContent);
    return;
  }
  if (arquivoImagem.size > 10 * 1024 * 1024) {
    statusMessage.textContent = 'A imagem deve ter no máximo 10 MB.';
    showNotification(statusMessage.textContent);
    return;
  }

  try {
    statusMessage.textContent =
      'Preparando a imagem para análise no servidor...';
    const image = await redimensionarImagem(arquivoImagem);
    const result = await apiRequest('/fish/identify', {
      method: 'POST',
      headers: { 'Content-Type': 'image/jpeg' },
      body: image,
    });
    await loadAccount();

    if (!result.identified) {
      statusMessage.textContent = result.message;
      txtEspecie.textContent = 'Peixe não identificado.';
      showNotification(result.message);
      salvarEstadoPlanejador();
      return;
    }

    txtEspecie.textContent =
      result.commonName +
      ' (' +
      result.scientificName +
      ') - sugestão da IA; pode estar incorreta.';
    especieIdentificada = txtEspecie.textContent;
    document.querySelector('.planejador-especie').textContent =
      especieIdentificada;
    renderizarFontesCuidados(result.sources ?? []);

    if (result.care) {
      const care = result.care;
      txtCuidados.textContent = [
        `Aquário e espaço: ${care.aquarium}`,
        `Temperatura: ${care.temperature}`,
        `Água (pH/dureza): ${care.water}`,
        `Alimentação: ${care.diet}`,
        `Comportamento e convivência: ${care.behavior}`,
        `Outros cuidados: ${care.other}`,
        'Resumo da IA baseado nas fontes consultadas; confira as fontes e a identificação antes de aplicar.',
      ].join('\n\n');
      statusMessage.textContent =
        'Identificação concluída. Confira as fontes antes de seguir os cuidados.';
    } else {
      txtCuidados.textContent =
        result.careMessage ||
        'Não foi possível encontrar cuidados com fontes confiáveis.';
      statusMessage.textContent =
        'Identificação concluída; os cuidados não estão disponíveis.';
      showNotification(txtCuidados.textContent);
    }

    salvarEstadoPlanejador();
  } catch (error) {
    console.error('Erro na identificacao do peixe:', error);
    statusMessage.textContent = error.message;
    showNotification(error.message);
    txtEspecie.textContent = error.message;
    txtCuidados.textContent = '';
  }
}

async function analisarCompatibilidade() {
  const botao = document.querySelector('.analisar-compatibilidade');
  const status = document.querySelector('.planejador-status');
  const resultado = document.querySelector('.planejador-resultado');
  const peixesExistentes = [...document.querySelectorAll('.peixe-existente')]
    .map((campo) => campo.value.trim())
    .filter(Boolean);

  resultado.textContent = '';
  if (!especieIdentificada) {
    status.textContent =
      'Identifique primeiro um peixe na aba Identificar Peixe.';
    showNotification(status.textContent);
    return;
  }
  if (peixesExistentes.length === 0) {
    status.textContent =
      'Informe pelo menos uma espécie que já vive no aquário.';
    showNotification(status.textContent);
    return;
  }
  botao.disabled = true;
  status.textContent = 'Analisando as espécies...';

  try {
    const resposta = await apiRequest('/tools/plan-fauna', {
      method: 'POST',
      body: JSON.stringify({
        newSpecies: especieIdentificada,
        existingSpecies: peixesExistentes,
      }),
    });
    await loadAccount();
    resultado.textContent = resposta.analysis;
    status.textContent = 'Análise concluída. Confira as ressalvas abaixo.';
    salvarEstadoPlanejador();
  } catch (erro) {
    console.error('Erro ao analisar compatibilidade:', erro);
    status.textContent = erro.message;
    if (erro.status === 402) {
      showNotification(erro.message);
    }
  } finally {
    botao.disabled = false;
  }
}

function openTab(evt, tabName) {
  var i, tabcontent, tabbuttons;
  tabcontent = document.getElementsByClassName('tab-content');
  for (i = 0; i < tabcontent.length; i++) {
    tabcontent[i].style.display = 'none';
    tabcontent[i].setAttribute('aria-hidden', 'true');
  }
  tabbuttons = document.getElementsByClassName('tab-button');
  for (i = 0; i < tabbuttons.length; i++) {
    tabbuttons[i].className = tabbuttons[i].className.replace(' active', '');
    tabbuttons[i].setAttribute('aria-selected', 'false');
  }
  document.getElementById(tabName).style.display = 'block';
  document.getElementById(tabName).setAttribute('aria-hidden', 'false');
  evt.currentTarget.className += ' active';
  evt.currentTarget.setAttribute('aria-selected', 'true');
}

async function calcularLitros() {
  const comprimento = Number.parseFloat(
    document.getElementById('comprimentoAquario').value,
  );
  const largura = Number.parseFloat(
    document.getElementById('larguraAquario').value,
  );
  const altura = Number.parseFloat(
    document.getElementById('alturaAquario').value,
  );
  const resultado = document.querySelector('.litros-resultado');
  const mensagemErro = document.querySelector('.litros-erro');

  if (
    ![comprimento, largura, altura].every(Number.isFinite) ||
    [comprimento, largura, altura].some((medida) => medida <= 0)
  ) {
    resultado.innerText = '';
    mensagemErro.innerText = 'Informe medidas maiores que zero em centímetros.';
    showNotification(mensagemErro.innerText);
    return;
  }
  const botao = document.querySelector('.calcular-litros');
  botao.disabled = true;
  mensagemErro.innerText = '';
  try {
    const data = await apiRequest('/tools/calculate-liters', {
      method: 'POST',
      body: JSON.stringify({
        length: comprimento,
        width: largura,
        height: altura,
      }),
    });
    resultado.innerText = Number(data.liters).toFixed(2);
    await loadAccount();
  } catch (erro) {
    resultado.innerText = '';
    mensagemErro.innerText = erro.message;
    if (erro.status === 402) {
      showNotification(erro.message);
    }
  } finally {
    botao.disabled = false;
  }
}

async function buscarLojasProximas() {
  const campoCep = document.querySelector('.cep-busca');
  const botaoBusca = document.querySelector('.buscar-lojas');
  const status = document.querySelector('.lojas-status');
  const cep = campoCep.value.replace(/\D/g, '');

  if (!/^\d{8}$/.test(cep)) {
    status.textContent = 'Digite um CEP válido com 8 números.';
    showNotification(status.textContent);
    campoCep.focus();
    return;
  }

  if (botaoBusca.disabled) {
    return;
  }

  botaoBusca.disabled = true;
  status.textContent = 'Localizando o CEP para abrir a pesquisa...';

  const janela = window.open('about:blank', '_blank');
  if (!janela) {
    botaoBusca.disabled = false;
    status.textContent =
      'O navegador bloqueou a nova aba. Permita pop-ups e tente novamente.';
    return;
  }
  janela.opener = null;
  janela.document.title = 'Abrindo a pesquisa no Google Maps';
  janela.document.body.textContent = 'Localizando o CEP...';

  try {
    const data = await apiRequest('/tools/find-stores', {
      method: 'POST',
      body: JSON.stringify({ cep }),
    });
    await loadAccount();
    janela.location.replace(data.mapsUrl);
    status.textContent = 'Pesquisa aberta no Google Maps.';
  } catch (erro) {
    console.error('Erro ao localizar CEP para a busca no Google Maps:', erro);
    janela.close();
    status.textContent = erro.message;
    if (erro.status === 402) {
      showNotification(erro.message);
    }
  } finally {
    botaoBusca.disabled = false;
  }
}

document.addEventListener('DOMContentLoaded', () => {
  restaurarEstadoPlanejador();
  document
    .querySelector('.notification-toast-close')
    .addEventListener('click', () => {
      document.querySelector('.notification-toast').hidden = true;
      clearTimeout(notificationTimeout);
    });
  document
    .querySelector('#registerForm')
    .addEventListener('submit', registerAccount);
  document.querySelector('#loginForm').addEventListener('submit', loginAccount);
  document.querySelector('#tabCadastro').addEventListener('click', () => {
    showAccountForm('register');
  });
  document.querySelector('#tabLogin').addEventListener('click', () => {
    showAccountForm('login');
  });
  document
    .querySelector('.iniciar-checkout')
    .addEventListener('click', startSubscriptionCheckout);
  document
    .querySelector('.cancelar-assinatura')
    .addEventListener('click', cancelSubscription);
  document.querySelector('.sair-conta').addEventListener('click', () => {
    clearAccount();
    setAccountMessage('Você saiu da sua conta.');
  });
  if (sessionStorage.getItem('accessToken')) {
    loadAccount();
  }
  document.querySelectorAll('.tab-button').forEach((button) => {
    button.addEventListener('click', (event) =>
      openTab(event, button.getAttribute('aria-controls')),
    );
  });
  document.querySelector('.foto').addEventListener('change', lerFoto);
  document
    .querySelector('.calcular-litros')
    .addEventListener('click', calcularLitros);
  document
    .querySelector('.analisar-compatibilidade')
    .addEventListener('click', analisarCompatibilidade);
  document.querySelectorAll('.peixe-existente').forEach((campo) => {
    campo.addEventListener('input', () => {
      document.querySelector('.planejador-resultado').textContent = '';
      salvarEstadoPlanejador();
    });
  });
  document
    .querySelector('.buscar-lojas')
    .addEventListener('click', buscarLojasProximas);
  document.querySelector('.cep-busca').addEventListener('keydown', (event) => {
    if (event.key === 'Enter') {
      buscarLojasProximas();
    }
  });
  document.querySelector('.tab-button').click();
});
