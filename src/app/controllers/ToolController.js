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
          let responseFromCep;
          try {
            responseFromCep = await fetch(
              `https://cep.awesomeapi.com.br/json/${input.cep}`,
              { signal: AbortSignal.timeout(5000) },
            );
          } catch (error) {
            throw new StoreLookupError(
              503,
              'Não foi possível localizar o CEP agora. Tente novamente.',
              { cause: error },
            );
          }

          if (responseFromCep.status === 404) {
            throw new StoreLookupError(
              404,
              'CEP não encontrado. Confira o número e tente novamente.',
            );
          }
          if (!responseFromCep.ok) {
            throw new StoreLookupError(
              503,
              'O serviço de CEP está indisponível agora. Tente novamente.',
            );
          }

          let address;
          try {
            address = await responseFromCep.json();
          } catch (error) {
            throw new StoreLookupError(
              503,
              'O serviço de CEP retornou dados inválidos. Tente novamente.',
              { cause: error },
            );
          }

          if (!address.address || !address.city || !address.state) {
            throw new StoreLookupError(
              422,
              'Não foi possível obter o endereço completo desse CEP para pesquisar no Google Maps.',
            );
          }

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
