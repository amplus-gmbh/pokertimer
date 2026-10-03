// Reine Rechenfunktionen für Chipkoffer, Color-up und Auszahlung.
// Ohne DOM-Zugriff, damit sie auch in Node getestet werden können.

const DEFAULT_CHIP_CASE = [
  { value: 25, count: 100 },
  { value: 100, count: 100 },
  { value: 500, count: 100 },
  { value: 1000, count: 100 },
  { value: 5000, count: 50 }
];
const MAX_CHIP_ROWS = 7;
const MAX_SEARCH_STEPS = 3000000;

function sanitizeChipCase(rows) {
  if (!Array.isArray(rows)) return DEFAULT_CHIP_CASE.map((row) => ({ ...row }));
  const byValue = new Map();
  for (const row of rows) {
    const value = Math.floor(Number(row?.value));
    const count = Math.floor(Number(row?.count));
    if (!Number.isFinite(value) || value < 1 || value > 10000000) continue;
    byValue.set(value, Math.max(0, Math.min(100000, Number.isFinite(count) ? count : 0)));
  }
  return [...byValue].map(([value, count]) => ({ value, count }))
    .sort((a, b) => a.value - b.value)
    .slice(0, MAX_CHIP_ROWS);
}

function greatestCommonDivisor(a, b) {
  return b ? greatestCommonDivisor(b, a % b) : a;
}

// Bewertet eine Stückelung: genug kleine Chips für die ersten Level,
// alle sinnvollen Werte vertreten, keine riesigen Chips im Startstack.
function scoreDistribution(values, counts, stack) {
  let score = 0;
  let usableIndex = 0;
  values.forEach((value, index) => {
    const count = counts[index];
    if (value > stack / 5) {
      score += count * 25;
      return;
    }
    const target = usableIndex < 2 ? 10 : 6;
    usableIndex += 1;
    if (count === 0) score += 40;
    score += Math.abs(count - target) * 2;
  });
  const total = counts.reduce((sum, count) => sum + count, 0);
  if (total > 50) score += (total - 50) * 3;
  if (total < 15) score += (15 - total) * 3;
  return score;
}

function searchDistribution(chips, stack, sets) {
  const values = chips.map((chip) => chip.value);
  const perChipCap = values.length <= 5 ? 40 : 25;
  const caps = chips.map((chip, index) => Math.min(
    Math.floor(chip.count / sets),
    Math.floor(stack / chip.value),
    index === chips.length - 1 ? Infinity : perChipCap
  ));
  // Ggt der jeweils restlichen Werte: frühes Abbrechen, wenn der Rest nicht darstellbar ist.
  const suffixGcd = values.map((_, index) => values.slice(index).reduce(greatestCommonDivisor));
  const counts = new Array(values.length).fill(0);
  let best = null;
  let steps = 0;

  function visit(index, remaining) {
    if (steps++ > MAX_SEARCH_STEPS) return;
    if (remaining % suffixGcd[index] !== 0) return;
    if (index === values.length - 1) {
      const count = remaining / values[index];
      if (count > caps[index]) return;
      counts[index] = count;
      const score = scoreDistribution(values, counts, stack);
      if (!best || score < best.score) best = { score, counts: [...counts] };
      return;
    }
    for (let count = 0; count <= caps[index] && count * values[index] <= remaining; count += 1) {
      counts[index] = count;
      visit(index + 1, remaining - count * values[index]);
    }
  }

  visit(0, stack);
  return best;
}

// Stückelung des Startstacks für alle Spieler plus Rebuy-Reserve.
function distributeStack(chipCase, stack, players, reserve) {
  const chips = sanitizeChipCase(chipCase).filter((chip) => chip.count > 0);
  const sets = players + reserve;
  if (!chips.length) return { ok: false, reason: 'Keine Chips im Koffer eingetragen.' };

  const caseValue = chips.reduce((sum, chip) => sum + chip.value * chip.count, 0);
  if (caseValue < stack * sets) {
    return {
      ok: false,
      reason: `Der Koffer hat ${formatChipNumber(caseValue)} Chips Gesamtwert, gebraucht werden ${sets} × ${formatChipNumber(stack)} = ${formatChipNumber(stack * sets)}.`,
      maxSets: Math.floor(caseValue / stack)
    };
  }
  const smallest = chips.map((chip) => chip.value).reduce(greatestCommonDivisor);
  if (stack % smallest !== 0) {
    return { ok: false, reason: `Ein Startstack von ${formatChipNumber(stack)} lässt sich mit diesen Chips nicht exakt bilden (Vielfaches von ${formatChipNumber(smallest)} nötig).` };
  }

  const best = searchDistribution(chips, stack, sets);
  if (!best) {
    // Weniger Stacks sind immer mindestens so gut machbar: binär nach dem Maximum suchen.
    let maxSets = 0;
    let high = sets - 1;
    while (maxSets < high) {
      const middle = Math.ceil((maxSets + high) / 2);
      if (searchDistribution(chips, stack, middle)) maxSets = middle;
      else high = middle - 1;
    }
    return {
      ok: false,
      reason: maxSets > 0
        ? `Die Chips reichen in dieser Stückelung nur für ${maxSets} Startstacks, gebraucht werden ${sets}.`
        : 'Mit diesen Chips lässt sich kein Startstack bilden.',
      maxSets
    };
  }

  const rows = chips.map((chip, index) => ({
    value: chip.value,
    perPlayer: best.counts[index],
    needed: best.counts[index] * sets,
    available: chip.count,
    rest: chip.count - best.counts[index] * sets
  }));
  const inPlay = rows.filter((row) => row.perPlayer > 0);
  const warnings = [];
  const large = inPlay.filter((row) => row.value > stack / 4);
  if (large.length) {
    warnings.push(`Der Startstack enthält grosse Chips (${large.map((row) => formatChipNumber(row.value)).join(', ')}); es fehlt Wechselgeld. Mehr kleine Chips oder ein kleinerer Startstack helfen.`);
  }
  if (inPlay.length && inPlay[0].perPlayer < 4) {
    warnings.push(`Nur ${inPlay[0].perPlayer} Chips à ${formatChipNumber(inPlay[0].value)} pro Spieler – zu wenig für die ersten Level.`);
  }
  return {
    ok: true,
    sets,
    rows,
    warnings,
    chipsPerPlayer: best.counts.reduce((sum, count) => sum + count, 0),
    valuesInPlay: inPlay.map((row) => row.value)
  };
}

// Prüft eine Blindstruktur gegen die Chips im Spiel und ermittelt Color-ups.
// valuesInPlay: aufsteigend sortierte Chipwerte, die im Startstack vorkommen.
function analyzeStructure(levels, valuesInPlay) {
  const result = { unpayable: new Set(), colorUps: new Map() };
  if (!valuesInPlay.length) return result;
  const amounts = (level) => (level.type === 'break' ? [] : [level.smallBlind, level.bigBlind, level.ante].filter((amount) => amount > 0));
  const smallest = valuesInPlay[0];

  levels.forEach((level, index) => {
    if (amounts(level).some((amount) => amount % smallest !== 0)) result.unpayable.add(index);
  });

  // Ein Chip kann raus, sobald alle folgenden Beträge mit den grösseren Chips bezahlbar sind.
  // Steht davor eine Pause, fällt der Color-up automatisch in diese Pause.
  let earliest = 0;
  for (let chip = 0; chip < valuesInPlay.length - 1; chip += 1) {
    const divisor = valuesInPlay.slice(chip + 1).reduce(greatestCommonDivisor);
    let start = levels.length;
    while (start > 0 && amounts(levels[start - 1]).every((amount) => amount % divisor === 0)) start -= 1;
    start = Math.max(start, earliest);
    if (start >= levels.length) break;
    earliest = start;
    if (start === 0) continue;
    const removed = result.colorUps.get(start) || [];
    removed.push(valuesInPlay[chip]);
    result.colorUps.set(start, removed);
  }
  return result;
}

// Übliche Verteilungen für Turniere; ab 11 Plätzen geometrisch abnehmend.
const PAYOUT_TEMPLATES = {
  1: [100],
  2: [65, 35],
  3: [50, 30, 20],
  4: [45, 27, 17, 11],
  5: [40, 25, 16, 11, 8],
  6: [37, 23, 15, 11, 8, 6],
  7: [35, 22, 14, 10, 8, 6, 5],
  8: [33, 21, 13, 10, 8, 6, 5, 4],
  9: [31, 20, 13, 10, 8, 6, 5, 4, 3],
  10: [30, 19, 12, 9, 7, 6, 5, 4, 4, 4]
};
const MAX_PAID_PLACES = 20;

function payoutTemplate(places) {
  const count = Math.max(1, Math.min(MAX_PAID_PLACES, Math.floor(places)));
  if (PAYOUT_TEMPLATES[count]) return [...PAYOUT_TEMPLATES[count]];
  const weights = Array.from({ length: count }, (_, index) => 0.82 ** index);
  const total = weights.reduce((sum, weight) => sum + weight, 0);
  const shares = weights.map((weight) => Math.max(1, Math.round((weight / total) * 100)));
  shares[0] += 100 - shares.reduce((sum, share) => sum + share, 0);
  return shares;
}

function recommendedPaidPlaces(entries) {
  if (entries <= 3) return 1;
  if (entries <= 6) return 2;
  if (entries <= 10) return 3;
  if (entries <= 20) return 4;
  if (entries <= 30) return 5;
  if (entries <= 40) return 6;
  return Math.min(MAX_PAID_PLACES, Math.round(entries * 0.15));
}

// Beträge auf ganze Franken abrunden; der Rundungsrest geht an den ersten Platz.
function payoutAmounts(pool, shares) {
  const amounts = shares.map((share) => Math.floor((pool * share) / 100));
  const total = shares.reduce((sum, share) => sum + share, 0);
  if (total === 100 && amounts.length) amounts[0] += Math.floor(pool) - amounts.reduce((sum, amount) => sum + amount, 0);
  return amounts;
}

function formatChipNumber(value) {
  return new Intl.NumberFormat('de-CH', { maximumFractionDigits: 0 }).format(value);
}

if (typeof module !== 'undefined') {
  module.exports = { DEFAULT_CHIP_CASE, sanitizeChipCase, distributeStack, analyzeStructure, payoutTemplate, recommendedPaidPlaces, payoutAmounts, MAX_PAID_PLACES };
}
