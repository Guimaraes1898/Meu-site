const trustedDomains = [
  'aquariumcoop.com',
  'seriouslyfish.com',
  'practicalfishkeeping.co.uk',
  'fishkeepingworld.com',
  'thesprucepets.com',
];
const trustedSitesQuery = trustedDomains
  .map((domain) => `site:${domain}`)
  .join(' OR ');

export class FishCareResearchError extends Error {
  constructor(message, options) {
    super(message, options);
    this.name = 'FishCareResearchError';
  }
}

export function parseFishCareSearchResults(data) {
  const results = [];
  const searchResults = Array.isArray(data?.results) ? data.results : [];

  for (const result of searchResults) {
    if (
      typeof result?.title !== 'string' ||
      typeof result?.url !== 'string' ||
      typeof result?.content !== 'string'
    ) {
      continue;
    }

    let url;
    try {
      url = new URL(result.url);
    } catch {
      continue;
    }

    const isTrusted = trustedDomains.some(
      (domain) =>
        url.hostname === domain || url.hostname.endsWith(`.${domain}`),
    );
    if (
      url.protocol !== 'https:' ||
      url.username ||
      url.password ||
      url.port ||
      !isTrusted
    ) {
      continue;
    }

    const title = result.title.trim().slice(0, 200);
    const snippet = result.content.trim().slice(0, 700);
    if (title && snippet) {
      results.push({ title, url: url.href, snippet });
    }
    if (results.length === 5) {
      break;
    }
  }

  return results;
}

export async function searchFishCareSources(scientificName, options = {}) {
  const baseUrl =
    options.baseUrl ??
    process.env.FISH_SEARCH_URL ??
    (process.env.NODE_ENV === 'production'
      ? undefined
      : 'http://localhost:8080');
  const fetchImplementation = options.fetchImplementation ?? fetch;

  if (typeof baseUrl !== 'string' || !baseUrl.trim()) {
    throw new FishCareResearchError(
      'A pesquisa de cuidados não está configurada. Defina FISH_SEARCH_URL no ambiente do backend.',
    );
  }

  let url;
  try {
    const instanceUrl = new URL(baseUrl);
    if (
      !['http:', 'https:'].includes(instanceUrl.protocol) ||
      instanceUrl.username ||
      instanceUrl.password
    ) {
      throw new Error('Invalid SearXNG URL.');
    }
    url = new URL('/search', instanceUrl);
  } catch (error) {
    throw new FishCareResearchError(
      'A URL da instância de pesquisa (FISH_SEARCH_URL) é inválida.',
      { cause: error },
    );
  }

  url.searchParams.set(
    'q',
    `"${scientificName}" aquarium care ${trustedSitesQuery}`,
  );
  url.searchParams.set('format', 'json');
  url.searchParams.set('language', 'en-US');

  let response;
  try {
    response = await fetchImplementation(url, {
      headers: { Accept: 'application/json' },
      signal: AbortSignal.timeout(10000),
    });
  } catch (error) {
    throw new FishCareResearchError(
      'Não foi possível pesquisar fontes de cuidados agora. Confira se a instância SearXNG está disponível e tente novamente.',
      { cause: error },
    );
  }

  if (!response.ok) {
    throw new FishCareResearchError(
      `A pesquisa de cuidados falhou (HTTP ${response.status}). Confira a instância SearXNG e se o formato JSON está habilitado.`,
    );
  }

  let data;
  try {
    data = await response.json();
  } catch (error) {
    throw new FishCareResearchError(
      'O serviço de pesquisa retornou uma resposta inválida. Tente novamente mais tarde.',
      { cause: error },
    );
  }

  if (!Array.isArray(data?.results)) {
    throw new FishCareResearchError(
      'O serviço de pesquisa retornou dados incompletos. Confira a configuração JSON do SearXNG.',
    );
  }

  return parseFishCareSearchResults(data);
}
