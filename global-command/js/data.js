// Static game data: terrain, unit roster, factions, cities and regions.
window.WG = window.WG || {};

WG.TERRAIN = {
  '.': { name: 'Ocean', water: true, def: 0 },
  'x': { name: 'Pack Ice', water: true, impassable: true, def: 0 },
  'p': { name: 'Plains', cost: { foot: 1, tread: 1 }, def: 0 },
  'f': { name: 'Forest', cost: { foot: 2, tread: 2 }, def: 0.25 },
  'h': { name: 'Hills', cost: { foot: 2, tread: 2 }, def: 0.3 },
  'm': { name: 'Mountains', cost: { foot: 3, tread: 4 }, def: 0.6 },
  'd': { name: 'Desert', cost: { foot: 2, tread: 1 }, def: 0 },
  't': { name: 'Tundra', cost: { foot: 2, tread: 2 }, def: 0.1 },
  'i': { name: 'Ice Sheet', cost: { foot: 3, tread: 3 }, def: 0 },
};

// atk: attack strength against Land / Air / Sea (surface) / Underwater targets.
// cls: what kind of target the unit itself is.
WG.UNITS = {
  infantry: {
    name: 'Infantry', domain: 'land', move: 'foot', mv: 3, vis: 2, cls: 'L',
    atk: { L: 4, A: 1, S: 1, U: 0 }, def: 4, rmin: 1, rmax: 1, cost: 6, capture: true,
    desc: 'Cheap, sturdy line troops. Best value for holding cities and rough terrain.',
  },
  armor: {
    name: 'Armor', domain: 'land', move: 'tread', mv: 5, vis: 2, cls: 'L',
    atk: { L: 7, A: 1, S: 1, U: 0 }, def: 5, rmin: 1, rmax: 1, cost: 14, capture: true,
    desc: 'Fast, hard-hitting breakthrough force. Struggles in mountains and forest.',
  },
  artillery: {
    name: 'Artillery', domain: 'land', move: 'tread', mv: 3, vis: 2, cls: 'L',
    atk: { L: 7, A: 0, S: 5, U: 0 }, def: 2, rmin: 2, rmax: 3, cost: 12, capture: true, indirect: true,
    desc: 'Indirect fire at range 2-3. Cannot fire after moving. Never receives counter-fire.',
  },
  aa: {
    name: 'Anti-Air', domain: 'land', move: 'tread', mv: 4, vis: 3, cls: 'L',
    atk: { L: 2, A: 8, S: 0, U: 0 }, def: 4, rmin: 1, rmax: 1, cost: 10, capture: true, aa: true,
    desc: 'Shreds aircraft, covers adjacent friendlies from air strikes and can shoot down ICBMs.',
  },
  fighter: {
    name: 'Fighter', domain: 'air', move: 'air', mv: 8, vis: 4, cls: 'A',
    atk: { L: 3, A: 8, S: 3, U: 0 }, def: 6, rmin: 1, rmax: 1, cost: 16, strikeAndReturn: true,
    desc: 'Air superiority. May keep moving after attacking. Loses 3 HP if it ends a turn away from a city or carrier.',
  },
  bomber: {
    name: 'Bomber', domain: 'air', move: 'air', mv: 10, vis: 3, cls: 'A',
    atk: { L: 8, A: 0, S: 7, U: 4 }, def: 3, rmin: 1, rmax: 1, cost: 22, strikeAndReturn: true,
    desc: 'Long-range strikes on ground and naval targets. Vulnerable to fighters and AA.',
  },
  destroyer: {
    name: 'Destroyer', domain: 'sea', move: 'sea', mv: 6, vis: 3, cls: 'S',
    atk: { L: 3, A: 4, S: 6, U: 8 }, def: 5, rmin: 1, rmax: 1, cost: 14,
    desc: 'Fast escort. The best submarine hunter, decent against aircraft.',
  },
  submarine: {
    name: 'Submarine', domain: 'sea', move: 'sea', mv: 5, vis: 2, cls: 'U',
    atk: { L: 0, A: 0, S: 8, U: 5 }, def: 4, rmin: 1, rmax: 1, cost: 16, stealth: true,
    desc: 'Stealthy. Invisible to enemies unless they are adjacent. Deadly to ships and embarked troops.',
  },
  battleship: {
    name: 'Battleship', domain: 'sea', move: 'sea', mv: 4, vis: 3, cls: 'S',
    atk: { L: 7, A: 3, S: 7, U: 0 }, def: 8, rmin: 1, rmax: 3, cost: 30,
    desc: 'Floating fortress. Bombards targets up to 3 hexes away, even after moving.',
  },
  carrier: {
    name: 'Carrier', domain: 'sea', move: 'sea', mv: 5, vis: 4, cls: 'S',
    atk: { L: 0, A: 3, S: 1, U: 0 }, def: 6, rmin: 1, rmax: 1, cost: 26, airbase: true,
    desc: 'Mobile airbase. An aircraft parked on it is carried along and avoids out-of-base attrition.',
  },
};
WG.UNIT_ORDER = ['infantry', 'armor', 'artillery', 'aa', 'fighter', 'bomber', 'destroyer', 'submarine', 'battleship', 'carrier'];

WG.RULES = {
  maxHp: 10,
  embarkMv: 4,          // movement points of land units at sea
  embarkDef: 1,         // defence of embarked land units
  airAttrition: 3,      // HP lost by aircraft ending a turn away from a base
  healField: 1, healCity: 3,
  entrenchBonus: 0.2,
  cityDef: 0.5, capitalDef: 0.75, portDef: 0.25,
  aaCoverFactor: 0.5,
  missileCost: 30, missileRange: 32, missileMax: 3,
  missileDmg: 7, missileSplash: 3, missileIntercept: 0.3, missileInterceptRange: 2,
  cityIncome: [0, 2, 4, 6], capitalIncome: 4,
  startCredits: 30,
  upkeepFree: 10, upkeepPerCity: 1, upkeepRate: 0.5, // units beyond the free allowance cost 0.5 credits/turn each
  unrestTurns: 2,        // turns a captured city yields nothing and cannot build
  dominationShare: 0.6,  // fraction of all cities needed for a domination victory
  difficulty: {
    easy:   { name: 'Easy',    aiIncome: 0.75, aiStart: 0.8 },
    normal: { name: 'Normal',  aiIncome: 1.0,  aiStart: 1.0 },
    hard:   { name: 'Hard',    aiIncome: 1.35, aiStart: 1.4 },
  },
};

WG.FACTIONS = [
  { name: 'Columbia Union',       short: 'CU', color: '#3d8bfd', capital: 'New York',  start: ['New York', 'Chicago', 'Houston'] },
  { name: 'Southern Cross',       short: 'SC', color: '#2fbf71', capital: 'São Paulo', start: ['São Paulo', 'Brasília', 'Buenos Aires'] },
  { name: 'European Directorate', short: 'ED', color: '#a970ff', capital: 'Paris',     start: ['Paris', 'London', 'Madrid'] },
  { name: 'Pan-African Coalition',short: 'PA', color: '#f08c2e', capital: 'Lagos',     start: ['Lagos', 'Kinshasa', 'Luanda'] },
  { name: 'Northern Federation',  short: 'NF', color: '#e5484d', capital: 'Moscow',    start: ['Moscow', 'St Petersburg', 'Yekaterinburg'] },
  { name: 'Pacific Concord',      short: 'PC', color: '#f5c518', capital: 'Beijing',   start: ['Beijing', 'Shanghai', 'Seoul'] },
  { name: 'Indus Compact',        short: 'IC', color: '#19c4b4', capital: 'Delhi',     start: ['Delhi', 'Mumbai', 'Karachi'] },
];

WG.REGIONS = {
  NA: { name: 'North America', bonus: 8 },
  SA: { name: 'South America', bonus: 6 },
  EU: { name: 'Europe', bonus: 8 },
  AF: { name: 'Africa', bonus: 8 },
  ME: { name: 'Middle East & Central Asia', bonus: 6 },
  RU: { name: 'Siberia & the North', bonus: 6 },
  SAS:{ name: 'South Asia', bonus: 4 },
  EA: { name: 'East Asia', bonus: 8 },
  OC: { name: 'Oceania', bonus: 5 },
};

// [name, lat, lon, size 1-3, region, optional [col,row] hex override]
WG.CITY_DATA = [
  ['New York', 40.7, -74.0, 3, 'NA'], ['Chicago', 41.9, -87.6, 3, 'NA'], ['Los Angeles', 34.0, -118.2, 3, 'NA'],
  ['Houston', 29.8, -95.4, 2, 'NA'], ['Seattle', 47.6, -122.3, 2, 'NA'], ['Denver', 39.7, -105.0, 1, 'NA'],
  ['Miami', 25.8, -80.2, 2, 'NA'], ['Winnipeg', 49.9, -97.1, 1, 'NA'],
  ['Edmonton', 53.5, -113.5, 1, 'NA'], ['Anchorage', 61.2, -149.9, 1, 'NA'], ['Mexico City', 19.4, -99.1, 3, 'NA'],
  ['Panama', 9.0, -79.5, 2, 'NA'], ['Nuuk', 64.2, -51.7, 1, 'NA'], ['Atlanta', 33.7, -84.4, 1, 'NA'],
  ['Honolulu', 21.3, -157.9, 1, 'OC'],

  ['São Paulo', -23.5, -46.6, 3, 'SA'], ['Brasília', -15.8, -47.9, 2, 'SA'], ['Buenos Aires', -34.6, -58.4, 3, 'SA'],
  ['Santiago', -33.4, -70.6, 2, 'SA'], ['Lima', -12.0, -77.0, 2, 'SA'], ['Quito', -0.2, -78.5, 1, 'SA'],
  ['Caracas', 10.5, -66.9, 2, 'SA'], ['Manaus', -3.1, -60.0, 1, 'SA'], ['Recife', -8.0, -34.9, 2, 'SA'],
  ['La Paz', -16.5, -68.1, 1, 'SA'], ['Punta Arenas', -53.0, -70.9, 1, 'SA'],

  ['London', 51.5, -0.1, 3, 'EU'], ['Paris', 48.9, 2.35, 3, 'EU'], ['Berlin', 52.5, 13.4, 3, 'EU'],
  ['Madrid', 40.4, -3.7, 2, 'EU'], ['Rome', 41.9, 12.5, 2, 'EU'], ['Stockholm', 59.3, 18.1, 2, 'EU'],
  ['Warsaw', 52.2, 21.0, 2, 'EU'], ['Kyiv', 50.45, 30.5, 2, 'EU'], ['Istanbul', 41.0, 29.0, 3, 'EU'],
  ['Athens', 38.0, 23.7, 1, 'EU'], ['Reykjavik', 64.1, -21.9, 1, 'EU'],

  ['Moscow', 55.75, 37.6, 3, 'RU'], ['St Petersburg', 59.9, 30.3, 2, 'RU'], ['Murmansk', 68.97, 33.1, 1, 'RU'],
  ['Yekaterinburg', 56.8, 60.6, 2, 'RU'], ['Novosibirsk', 55.0, 82.9, 2, 'RU'], ['Irkutsk', 52.3, 104.3, 1, 'RU'],
  ['Yakutsk', 62.0, 129.7, 1, 'RU'], ['Vladivostok', 43.1, 131.9, 2, 'RU'], ['Magadan', 59.6, 150.8, 1, 'RU'],
  ['Norilsk', 69.3, 88.2, 1, 'RU'], ['Volgograd', 48.7, 44.5, 1, 'RU'],

  ['Tehran', 35.7, 51.4, 3, 'ME'], ['Baghdad', 33.3, 44.4, 2, 'ME'], ['Riyadh', 24.7, 46.7, 2, 'ME'],
  ['Dubai', 25.2, 55.3, 1, 'ME'], ['Kabul', 34.5, 69.2, 1, 'ME'], ['Tashkent', 41.3, 69.2, 1, 'ME'],
  ['Almaty', 43.2, 76.9, 2, 'ME'],

  ['Cairo', 30.0, 31.2, 3, 'AF', [56, 15]], ['Lagos', 6.5, 3.4, 3, 'AF'], ['Kinshasa', -4.3, 15.3, 2, 'AF'],
  ['Nairobi', -1.3, 36.8, 2, 'AF'], ['Johannesburg', -26.2, 28.0, 3, 'AF'], ['Cape Town', -33.9, 18.4, 2, 'AF'],
  ['Algiers', 36.7, 3.0, 2, 'AF'], ['Casablanca', 33.6, -7.6, 1, 'AF'], ['Dakar', 14.7, -17.4, 2, 'AF'],
  ['Addis Ababa', 9.0, 38.7, 2, 'AF'], ['Khartoum', 15.6, 32.5, 1, 'AF'], ['Luanda', -8.8, 13.2, 1, 'AF'],
  ['Mogadishu', 2.0, 45.3, 1, 'AF'], ['Antananarivo', -18.9, 47.5, 1, 'AF'], ['Tripoli', 32.9, 13.2, 1, 'AF'],
  ['Timbuktu', 16.8, -3.0, 1, 'AF'],

  ['Delhi', 28.6, 77.2, 3, 'SAS'], ['Mumbai', 19.0, 72.8, 3, 'SAS'], ['Karachi', 24.9, 67.0, 2, 'SAS'],
  ['Kolkata', 22.6, 88.4, 2, 'SAS'], ['Colombo', 6.9, 79.9, 1, 'SAS'], ['Hyderabad', 17.4, 78.5, 1, 'SAS'],

  ['Beijing', 39.9, 116.4, 3, 'EA'], ['Shanghai', 31.2, 121.5, 3, 'EA'], ['Tokyo', 35.7, 139.7, 3, 'EA'],
  ['Seoul', 37.6, 127.0, 2, 'EA'], ['Hong Kong', 22.3, 114.2, 2, 'EA'], ['Chengdu', 30.7, 104.0, 2, 'EA'],
  ['Manila', 14.6, 121.0, 2, 'EA'], ['Bangkok', 13.8, 100.5, 2, 'EA'], ['Hanoi', 21.0, 105.8, 1, 'EA'],
  ['Singapore', 1.3, 103.8, 2, 'EA'], ['Surabaya', -7.25, 112.75, 2, 'EA'], ['Ulaanbaatar', 47.9, 106.9, 1, 'EA'],
  ['Harbin', 45.8, 126.5, 1, 'EA'], ['Urumqi', 43.8, 87.6, 1, 'EA'], ['Lhasa', 29.7, 91.1, 1, 'EA'],

  ['Sydney', -33.9, 151.2, 3, 'OC'], ['Melbourne', -37.8, 145.0, 2, 'OC'], ['Perth', -31.9, 115.9, 2, 'OC'],
  ['Darwin', -12.5, 130.8, 1, 'OC'], ['Brisbane', -27.5, 153.0, 1, 'OC'], ['Auckland', -36.8, 174.8, 2, 'OC'],
  ['Port Moresby', -9.4, 147.2, 1, 'OC'], ['Guam', 13.4, 144.8, 1, 'OC'], ['Suva', -18.1, 178.4, 1, 'OC'],
];
