import assert from 'node:assert/strict';
import test from 'node:test';
import FishController from '../src/app/controllers/FishController.js';
import { findFishCare } from '../src/app/services/fishCareCatalog.js';
import {
  FishCareResearchError,
  parseFishCareSearchResults,
  searchFishCareSources,
} from '../src/app/services/fishCareResearch.js';
import {
  PuterAIError,
  parseJsonResponse,
} from '../src/app/services/puterAI.js';

test('fish care summary parses JSON and rejects prose responses', () => {
  const fields = [
    'aquarium',
    'temperature',
    'water',
    'diet',
    'behavior',
    'other',
  ];
  const summary = Object.fromEntries(
    fields.map((field) => [field, 'Verified']),
  );

  assert.deepEqual(
    parseJsonResponse(
      {
        message: { content: `\`\`\`json\n${JSON.stringify(summary)}\n\`\`\`` },
      },
      fields,
      'Invalid summary',
    ),
    summary,
  );
  assert.throws(
    () =>
      parseJsonResponse(
        { message: { content: 'Here is the fish care summary.' } },
        fields,
        'Invalid summary',
      ),
    (error) =>
      error instanceof PuterAIError && error.message === 'Invalid summary',
  );
});

test('fish care catalog matches scientific names and known common aliases', () => {
  assert.equal(
    findFishCare(' BETTA SPLENDENS ')?.scientificName,
    'Betta splendens',
  );
  assert.equal(findFishCare('guppy')?.scientificName, 'Poecilia reticulata');
  assert.equal(findFishCare('unknown fish'), null);
});

test('fish care endpoint returns only a matching catalog entry', async () => {
  let statusCode;
  let responseBody;
  const response = {
    status(code) {
      statusCode = code;
      return this;
    },
    json(body) {
      responseBody = body;
      return this;
    },
  };

  await FishController.care(
    { body: { scientificName: 'Betta splendens' } },
    response,
  );

  assert.equal(statusCode, 200);
  assert.equal(responseBody.fish.commonName, 'Betta');
  assert.equal(
    responseBody.fish.source.name,
    'Aquarium Co-Op — Betta Fish Care Guide',
  );
  assert.equal('aliases' in responseBody.fish, false);
});

test('fish care endpoint rejects invalid and uncatalogued species', async () => {
  let statusCode;
  let responseBody;
  const response = {
    status(code) {
      statusCode = code;
      return this;
    },
    json(body) {
      responseBody = body;
      return this;
    },
  };

  await FishController.care({ body: {} }, response);
  assert.equal(statusCode, 400);

  await FishController.care(
    { body: { scientificName: 'unlisted species' } },
    response,
  );
  assert.equal(statusCode, 404);
  assert.match(responseBody.message, /ficha de cuidados cadastrada/);
});

test('fish care research keeps only HTTPS results from trusted aquarism sources', () => {
  const data = {
    results: [
      {
        title: 'Oscar & care',
        url: 'https://www.seriouslyfish.com/species/astronotus-ocellatus',
        content: 'Large cichlid; needs space & filtration.',
      },
      {
        title: 'Untrusted result',
        url: 'https://evil-seriouslyfish.com/fake',
        content: 'Injected source.',
      },
      {
        title: 'Insecure result',
        url: 'http://aquariumcoop.com/care',
        content: 'Insecure source.',
      },
    ],
  };

  assert.deepEqual(parseFishCareSearchResults(data), [
    {
      title: 'Oscar & care',
      url: 'https://www.seriouslyfish.com/species/astronotus-ocellatus',
      snippet: 'Large cichlid; needs space & filtration.',
    },
  ]);
});

test('fish care research endpoint validates species names before searching', async () => {
  let statusCode;
  let responseBody;
  const response = {
    status(code) {
      statusCode = code;
      return this;
    },
    json(body) {
      responseBody = body;
      return this;
    },
  };

  await FishController.research(
    { body: { scientificName: 'fish care site:evil.com' } },
    response,
  );

  assert.equal(statusCode, 400);
  assert.match(responseBody.message, /nome científico/);
});

test('fish care research requires a SearXNG URL and requests JSON sources', async () => {
  let requestedUrl;
  const fetchImplementation = async (url, options) => {
    requestedUrl = new URL(url);
    assert.equal(options.headers.Accept, 'application/json');
    return {
      ok: true,
      json: async () => ({
        results: [
          {
            title: 'Oscar care',
            url: 'https://www.seriouslyfish.com/species/astronotus-ocellatus',
            content: 'A large cichlid requiring a spacious aquarium.',
          },
        ],
      }),
    };
  };

  await assert.rejects(
    searchFishCareSources('Astronotus ocellatus', {
      baseUrl: '',
      fetchImplementation,
    }),
    /FISH_SEARCH_URL/,
  );
  const sources = await searchFishCareSources('Astronotus ocellatus', {
    baseUrl: 'http://localhost:8080',
    fetchImplementation,
  });
  assert.equal(requestedUrl.hostname, 'localhost');
  assert.equal(requestedUrl.pathname, '/search');
  assert.match(requestedUrl.searchParams.get('q'), /Astronotus ocellatus/);
  assert.equal(requestedUrl.searchParams.get('format'), 'json');
  assert.equal(requestedUrl.searchParams.get('language'), 'en-US');
  assert.equal(sources.length, 1);
  assert.equal(sources[0].title, 'Oscar care');
});

test('fish care research defaults to the local SearXNG instance in development', async () => {
  const originalSearchUrl = process.env.FISH_SEARCH_URL;
  const originalNodeEnv = process.env.NODE_ENV;
  let requestedUrl;
  delete process.env.FISH_SEARCH_URL;
  process.env.NODE_ENV = 'development';

  try {
    await searchFishCareSources('Betta splendens', {
      fetchImplementation: async (url) => {
        requestedUrl = new URL(url);
        return {
          ok: true,
          json: async () => ({ results: [] }),
        };
      },
    });
  } finally {
    if (originalSearchUrl === undefined) {
      delete process.env.FISH_SEARCH_URL;
    } else {
      process.env.FISH_SEARCH_URL = originalSearchUrl;
    }
    if (originalNodeEnv === undefined) {
      delete process.env.NODE_ENV;
    } else {
      process.env.NODE_ENV = originalNodeEnv;
    }
  }

  assert.equal(requestedUrl.origin, 'http://localhost:8080');
  assert.equal(requestedUrl.pathname, '/search');
});

test('fish care research rejects non-success responses from the search provider', async () => {
  const fetchImplementation = async () => ({
    ok: false,
    status: 429,
  });

  await assert.rejects(
    searchFishCareSources('Astronotus ocellatus', {
      baseUrl: 'http://localhost:8080',
      fetchImplementation,
    }),
    FishCareResearchError,
  );
});
