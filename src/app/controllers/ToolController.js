import * as yup from 'yup';
import {
  analyzeFauna,
  PuterAIError,
  PuterConfigurationError,
} from '../services/puterAI.js';
import { executeAuthorizedTool } from '../services/toolAccess.js';
import { sendToolOperationResponse } from './toolResponse.js';

const measurementSchema = yup.object({
  length: yup
    .number()
    .typeError('Informe medidas numéricas válidas.')
    .positive()
    .max(10000)
    .required(),
  width: yup
    .number()
    .typeError('Informe medidas numéricas válidas.')
    .positive()
    .max(10000)
    .required(),
  height: yup
    .number()
    .typeError('Informe medidas numéricas válidas.')
    .positive()
    .max(10000)
    .required(),
});

const faunaSchema = yup.object({
  newSpecies: yup.string().trim().min(1).max(300).required(),
  existingSpecies: yup
    .array()
    .of(yup.string().trim().min(1).max(200).required())
    .min(1)
    .max(5)
    .required(),
});

const storesSchema = yup.object({
  cep: yup
    .string()
    .matches(/^\d{8}$/)
    .required(),
});

class StoreLookupError extends Error {
  constructor(status, message, options) {
    super(message, options);
    this.name = 'StoreLookupError';
    this.status = status;
  }
}

const cepProviders = [
  {
    name: 'awesomeapi',
    url: (cep) => `https://cep.awesomeapi.com.br/json/${cep}`,
    parse: (data) => ({
      address: data.address,
      district: data.district,
      city: data.city,
      state: data.state,
    }),
  },
  {
    name: 'viacep',
    url: (cep) => `https://viacep.com.br/ws/${cep}/json/`,
    parse: (data) => ({
      address: data.logradouro,
      district: data.bairro,
      city: data.localidade,
      state: data.uf,
    }),
  },
  {
    name: 'brasilapi',
    url: (cep) => `https://brasilapi.com.br/api/cep/v2/${cep}`,
    parse: (data) => ({
      address: data.street,
      district: data.neighborhood,
      city: data.city,
      state: data.state,
    }),
  },
];

async function fetchCepFromProvider(provider, cep) {
  let response;
  try {
    response = await fetch(provider.url(cep), {
      signal: AbortSignal.timeout(5000),
    });
  } catch (error) {
    console.warn(`Busca de CEP: provedor ${provider.name} falhou.`, error);
    return null;
  }

  if (response.status === 404 || response.status === 400) {
    throw new StoreLookupError(
      404,
      'CEP não encontrado. Confira o número e tente novamente.',
    );
  }
  if (!response.ok) {
    console.warn(
      `Busca de CEP: provedor ${provider.name} respondeu HTTP ${response.status}.`,
    );
    return null;
  }

  let data;
  try {
    data = await response.json();
  } catch (error) {
    console.warn(
      `Busca de CEP: provedor ${provider.name} retornou dados inválidos.`,
      error,
    );
    return null;
  }

  if (data.erro === true || data.erro === 'true') {
    throw new StoreLookupError(
      404,
      'CEP não encontrado. Confira o número e tente novamente.',
    );
  }

  const address = provider.parse(data);
  if (!address.city || !address.state) {
    console.warn(
      `Busca de CEP: provedor ${provider.name} retornou endereço incompleto.`,
    );
    return null;
  }
  return address;
}

async function lookupCep(cep) {
  for (const provider of cepProviders) {
    const address = await fetchCepFromProvider(provider, cep);
    if (address) {
      return address;
    }
  }
  throw new StoreLookupError(
    503,
    'O serviço de CEP está indisponível agora. Tente novamente.',
  );
}

class ToolController {
  async calculateLiters(request, response) {
    let measurements;
    try {
      measurements = await measurementSchema.validate(request.body ?? {}, {
        abortEarly: false,
        stripUnknown: true,
      });
    } catch (error) {
      if (error instanceof yup.ValidationError) {
        return response.status(400).json({
          message: 'Informe comprimento, largura e altura em centímetros.',
        });
      }
      throw error;
    }

    const result = await executeAuthorizedTool(
      request.user.id,
      'calculate-liters',
      () => ({
        liters:
          (measurements.length * measurements.width * measurements.height) /
          1000,
      }),
    );
    return sendToolOperationResponse(response, result);
  }

  async planFauna(request, response) {
    let input;
    try {
      input = await faunaSchema.validate(request.body ?? {}, {
        abortEarly: false,
        stripUnknown: true,
      });
    } catch (error) {
      if (error instanceof yup.ValidationError) {
        return response.status(400).json({
          message:
            'Informe o peixe que deseja adicionar e de 1 a 5 espécies que já vivem no aquário.',
        });
      }
      throw error;
    }

    try {
      const result = await executeAuthorizedTool(
        request.user.id,
        'plan-fauna',
        async () => ({
          analysis: await analyzeFauna(input.newSpecies, input.existingSpecies),
        }),
      );
      return sendToolOperationResponse(response, result);
    } catch (error) {
      if (error instanceof PuterConfigurationError) {
        return response.status(503).json({ message: error.message });
      }
      if (error instanceof PuterAIError) {
        return response.status(502).json({ message: error.message });
      }
      throw error;
    }
  }

  async findStores(request, response) {
    let input;
    try {
      input = await storesSchema.validate(request.body ?? {}, {
        abortEarly: false,
        stripUnknown: true,
      });
    } catch (error) {
      if (error instanceof yup.ValidationError) {
        return response.status(400).json({
          message: 'Informe um CEP válido com 8 números.',
        });
      }
      throw error;
    }

    try {
      const result = await executeAuthorizedTool(
        request.user.id,
        'find-stores',
        async () => {
          const address = await lookupCep(input.cep);

          const locality = [
            address.address,
            address.district,
            address.city,
            address.state,
            'Brasil',
          ]
            .filter(Boolean)
            .join(', ');
          const query = `lojas de peixes ornamentais ou lojas de aquarismo perto de ${locality}`;
          const mapsUrl = new URL('https://www.google.com/maps/search/');
          mapsUrl.searchParams.set('api', '1');
          mapsUrl.searchParams.set('query', query);
          return { mapsUrl: mapsUrl.href };
        },
      );
      return sendToolOperationResponse(response, result);
    } catch (error) {
      if (error instanceof StoreLookupError) {
        return response.status(error.status).json({ message: error.message });
      }
      throw error;
    }
  }
}

export default new ToolController();
