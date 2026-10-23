const fishCareCatalog = [
  {
    scientificName: 'Betta splendens',
    commonName: 'Betta',
    aquarium:
      'Pelo menos 19 litros; um aquário maior, de até 38 litros, oferece mais espaço e ajuda a manter a água estável.',
    temperature: 'Em torno de 27 °C.',
    ph: null,
    diet: 'Ração específica para bettas; pode variar a alimentação com alimentos apropriados, como bloodworms.',
    notes:
      'Prefere filtragem com fluxo suave. A fonte consultada não especifica uma faixa de pH.',
    source: {
      name: 'Aquarium Co-Op — Betta Fish Care Guide',
      url: 'https://www.aquariumcoop.com/blogs/aquarium/betta-fish-care-guide',
    },
    aliases: ['betta', 'siamese fighting fish'],
  },
  {
    scientificName: 'Poecilia reticulata',
    commonName: 'Guppy',
    aquarium:
      'A partir de 19 litros para um pequeno grupo de três; considere mais espaço porque se reproduz com facilidade.',
    temperature:
      'Aproximadamente 22–26 °C; a fonte recomenda 24–26 °C para linhagens ornamentais.',
    ph: '7,0 ou superior; também prefere água mais dura e rica em minerais.',
    diet: 'Onívoro; varie alimentos em flocos ou pellets com alimentos apropriados, como artêmia.',
    notes:
      'Planeje a população do aquário: guppies podem se reproduzir rapidamente.',
    source: {
      name: 'Aquarium Co-Op — Guppy Care Guide',
      url: 'https://www.aquariumcoop.com/blogs/aquarium/guppy-care-guide',
    },
    aliases: ['guppy', 'millionfish'],
  },
];

function normalizeSpeciesName(value) {
  return value
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .trim()
    .replace(/\s+/g, ' ')
    .toLowerCase();
}

export function findFishCare(scientificName) {
  if (typeof scientificName !== 'string') {
    return null;
  }

  const normalizedName = normalizeSpeciesName(scientificName);
  const fish = fishCareCatalog.find(
    ({ scientificName: canonicalName, aliases }) =>
      normalizeSpeciesName(canonicalName) === normalizedName ||
      aliases.some((alias) => normalizeSpeciesName(alias) === normalizedName),
  );

  if (!fish) {
    return null;
  }

  const { aliases: _aliases, ...publicDetails } = fish;
  return publicDetails;
}
