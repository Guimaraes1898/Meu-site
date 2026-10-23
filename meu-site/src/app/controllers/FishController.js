import * as yup from 'yup';
import { findFishCare } from '../services/fishCareCatalog.js';
import {
  FishCareResearchError,
  searchFishCareSources,
} from '../services/fishCareResearch.js';
import {
  identifyFish,
  PuterAIError,
  PuterConfigurationError,
  summarizeFishCare,
} from '../services/puterAI.js';
import { executeAuthorizedTool } from '../services/toolAccess.js';
import { sendToolOperationResponse } from './toolResponse.js';

const careSchema = yup.object({
  scientificName: yup
    .string()
    .trim()
    .max(100)
    .matches(/^[\p{L}][\p{L}\s.'-]*$/u)
    .required(),
});

class FishController {
  async identify(request, response) {
    if (
      !Buffer.isBuffer(request.body) ||
      request.body.length < 4 ||
      request.body[0] !== 0xff ||
      request.body[1] !== 0xd8 ||
      request.body[2] !== 0xff
    ) {
      return response.status(400).json({
        message: 'Envie uma imagem JPEG válida para identificar o peixe.',
      });
    }

    try {
      const result = await executeAuthorizedTool(
        request.user.id,
        'identify-fish',
        async () => {
          const identification = await identifyFish(request.body);
          if (!identification.isFish) {
            return {
              identified: false,
              message:
                'Não foi possível identificar um peixe nesta imagem. Tente uma foto nítida com o peixe bem visível.',
            };
          }

          const scientificName = identification.scientificName.trim();
          const commonName = identification.commonName.trim();
          const fish = findFishCare(scientificName);
          let sources = [];

          if (fish) {
            sources = [
              {
                title: fish.source.name,
                url: fish.source.url,
                snippet: [
                  `Aquário: ${fish.aquarium}`,
                  `Temperatura: ${fish.temperature}`,
                  `pH: ${fish.ph ?? 'não especificado pela fonte'}`,
                  `Alimentação: ${fish.diet}`,
                  fish.notes,
                ]
                  .filter(Boolean)
                  .join('. '),
              },
            ];
          } else {
            sources = await searchFishCareSources(scientificName);
          }

          if (sources.length === 0) {
            throw new FishCareResearchError(
              'Não foram encontradas fontes confiáveis sobre os cuidados desta espécie.',
            );
          }

          const care = await summarizeFishCare(
            scientificName,
            commonName,
            sources,
          );
          return {
            identified: true,
            scientificName,
            commonName,
            care,
            sources,
          };
        },
      );
      return sendToolOperationResponse(response, result);
    } catch (error) {
      if (error instanceof PuterConfigurationError) {
        return response.status(503).json({ message: error.message });
      }
      if (error instanceof PuterAIError) {
        return response.status(502).json({ message: error.message });
      }
      if (error instanceof FishCareResearchError) {
        return response.status(503).json({ message: error.message });
      }
      throw error;
    }
  }

  async care(request, response) {
    let data;
    try {
      data = await careSchema.validate(request.body ?? {}, {
        abortEarly: false,
        stripUnknown: true,
      });
    } catch (error) {
      if (error instanceof yup.ValidationError) {
        return response.status(400).json({
          message: 'Informe o nome científico da espécie identificada.',
        });
      }
      throw error;
    }

    const fish = findFishCare(data.scientificName);
    if (!fish) {
      return response.status(404).json({
        message:
          'Ainda não temos uma ficha de cuidados cadastrada para esta espécie.',
      });
    }

    return response.status(200).json({ fish });
  }

  async research(request, response) {
    let data;
    try {
      data = await careSchema.validate(request.body ?? {}, {
        abortEarly: false,
        stripUnknown: true,
      });
    } catch (error) {
      if (error instanceof yup.ValidationError) {
        return response.status(400).json({
          message: 'Informe o nome científico da espécie identificada.',
        });
      }
      throw error;
    }

    try {
      const sources = await searchFishCareSources(data.scientificName);
      return response.status(200).json({ sources });
    } catch (error) {
      if (error instanceof FishCareResearchError) {
        return response.status(503).json({ message: error.message });
      }
      throw error;
    }
  }
}

export default new FishController();
