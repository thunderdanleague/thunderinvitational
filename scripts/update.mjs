/**
 * The Thunder Invitational — standings builder.
 *
 * Pulls every 2026 FBS game from CollegeFootballData, computes each owner's
 * aggregate record, and writes data/standings.json for the site to render.
 *
 * Run: CFBD_API_KEY=xxxx node scripts/update.mjs
 */

import fs from "node:fs";
import path from "node:path";

const KEY = process.env.CFBD_API_KEY;
if (!KEY) {
  console.error("Missing CFBD_API_KEY. Add it as a repository secret.");
  process.exit(1);
}

const ROOT = path.resolve(path.dirname(new URL(import.meta.url).pathname), "..");
const league = JSON.parse(fs.readFileSync(path.join(ROOT, "league.json"), "utf8"));
const YEAR = league.season;

/* CFBD has shipped both snake_case and camelCase over the years. Read either. */
const pick = (o, ...keys) => { for (const k of keys) if (o[k] !== undefined && o[k] !== null) return o[k]; };

async function fetchGames(seasonType) {
  const url = `https://api.collegefootballdata.com/games?year=${YEAR}&seasonType=${seasonType}`;
  const res = await fetch(url, { headers: { Authorization: `Bearer ${KEY}` } });
  if (!res.ok) throw new Error(`CFBD ${seasonType} returned ${res.status}: ${await res.text()}`);
  const raw = await res.json();
  return raw.map((g) => ({
    id: String(pick(g, "id")),
    week: Number(pick(g, "week")) || 0,
    seasonType,
    date: pick(g, "start_date", "startDate") || null,
    home: pick(g, "home_team", "homeTeam"),
    away: pick(g, "away_team", "awayTeam"),
    homePts: pick(g, "home_points", "homePoints"),
    awayPts: pick(g, "away_points", "awayPoints"),
    completed: pick(g, "completed") === true,
  }));
}

/* ---------- fetch ---------- */
const games = [...(await fetchGames("regular")), ...(await fetchGames("postseason"))];
console.log(`Fetched ${games.length} games for ${YEAR}.`);

/* ---------- verify every drafted team matches a real API team name ---------- */
const apiTeams = new Set();
games.forEach((g) => { apiTeams.add(g.home); apiTeams.add(g.away); });

const drafted = league.owners.flatMap((o) => o.teams);
const missing = drafted.filter((t) => !apiTeams.has(t));
if (missing.length) {
  console.error("\nThese drafted teams don't match any team name in the feed:");
  missing.forEach((m) => {
    const guess = [...apiTeams].filter((t) => t.toLowerCase().includes(m.toLowerCase().split(" ")[0]));
    console.error(`  "${m}"${guess.length ? `  — did you mean: ${guess.slice(0, 4).join(", ")}` : ""}`);
  });
  console.error("\nFix the spelling in league.json and run again. Refusing to publish bad standings.\n");
  process.exit(1);
}
console.log(`All ${drafted.length} drafted teams matched.`);

/* ---------- per-game outcomes ---------- */
const played = games
  .filter((g) => g.completed && Number.isFinite(g.homePts) && Number.isFinite(g.awayPts) && g.homePts !== g.awayPts)
  .map((g) => ({ ...g, winner: g.homePts > g.awayPts ? g.home : g.away }));

/* an ordering key so postseason sorts after the regular season */
const slot = (g) => (g.seasonType === "postseason" ? 100 + g.week : g.week);
const currentSlot = played.length ? Math.max(...played.map(slot)) : 0;

/* ---------- team records and schedules ---------- */
const teams = {};
for (const name of drafted) teams[name] = { w: 0, l: 0, games: [] };

for (const g of games) {
  for (const side of ["home", "away"]) {
    const name = g[side];
    if (!teams[name]) continue;
    const opp = side === "home" ? g.away : g.home;
    const done = played.some((p) => p.id === g.id);
    const won = done && played.find((p) => p.id === g.id).winner === name;
    const mine = side === "home" ? g.homePts : g.awayPts;
    const theirs = side === "home" ? g.awayPts : g.homePts;
    if (done) { won ? teams[name].w++ : teams[name].l++; }
    teams[name].games.push({
      week: g.week, slot: slot(g), postseason: g.seasonType === "postseason",
      opponent: opp, home: side === "home", date: g.date,
      result: done ? (won ? "W" : "L") : null,
      score: done ? `${mine}\u2013${theirs}` : null,
    });
  }
}
for (const t of Object.values(teams)) t.games.sort((a, b) => a.slot - b.slot);

/* ---------- owner totals, with a snapshot at every slot for movement arrows ---------- */
const pctOf = (w, l) => (w + l ? w / (w + l) : 0);

function standingsAt(upTo) {
  const rows = league.owners.map((o) => {
    let w = 0, l = 0;
    for (const g of played) {
      if (slot(g) > upTo) continue;
      const loser = g.winner === g.home ? g.away : g.home;
      if (o.teams.includes(g.winner)) w++;
      if (o.teams.includes(loser)) l++;
    }
    return { seat: o.seat, w, l, pct: pctOf(w, l) };
  });
  rows.sort((a, b) => b.pct - a.pct || b.w - a.w || a.seat - b.seat);
  let rank = 0, prev = null;
  rows.forEach((r, i) => { if (prev === null || r.pct < prev - 1e-9) { rank = i + 1; prev = r.pct; } r.rank = rank; });
  return Object.fromEntries(rows.map((r) => [r.seat, r]));
}

const history = [];
for (let s = 1; s <= currentSlot; s++) {
  const snap = standingsAt(s);
  if (Object.values(snap).every((r) => r.w + r.l === 0)) continue;
  history.push({ slot: s, ranks: Object.fromEntries(Object.entries(snap).map(([k, v]) => [k, v.rank])) });
}

const now = standingsAt(currentSlot);
const prevSnap = history.length > 1 ? history[history.length - 2].ranks : null;

const owners = league.owners.map((o) => {
  const cur = now[o.seat];
  const each = o.teams.map((t) => ({ team: t, w: teams[t].w, l: teams[t].l, pct: pctOf(teams[t].w, teams[t].l) }));

  /* this slot's results and the last three, for the streak marks */
  const window = (from) => {
    let w = 0, l = 0;
    for (const g of played) {
      if (slot(g) < from || slot(g) > currentSlot) continue;
      const loser = g.winner === g.home ? g.away : g.home;
      if (o.teams.includes(g.winner)) w++;
      if (o.teams.includes(loser)) l++;
    }
    return { w, l };
  };
  const thisWeek = window(currentSlot);
  const form = window(Math.max(1, currentSlot - 2));
  const fg = form.w + form.l;

  const remaining = o.teams.reduce((a, t) => a + teams[t].games.filter((g) => !g.result).length, 0);
  const total = cur.w + cur.l + remaining;

  return {
    seat: o.seat, name: o.name, teams: o.teams, each,
    w: cur.w, l: cur.l, pct: cur.pct, rank: cur.rank,
    move: prevSnap ? prevSnap[o.seat] - cur.rank : 0,
    thisWeek, form,
    hot: fg >= 6 && form.w / fg >= 0.7,
    cold: fg >= 6 && form.w / fg <= 0.35,
    remaining,
    ceiling: total ? (cur.w + remaining) / total : 0,
    floor: total ? cur.w / total : 0,
    rankHistory: history.map((h) => ({ slot: h.slot, rank: h.ranks[o.seat] })),
  };
});
owners.sort((a, b) => a.rank - b.rank || a.seat - b.seat);

/* ---------- upcoming games, for the what-if board ---------- */
const ownerOfTeam = {};
league.owners.forEach((o) => o.teams.forEach((t) => (ownerOfTeam[t] = o.seat)));
const upcoming = games
  .filter((g) => !played.some((p) => p.id === g.id))
  .filter((g) => ownerOfTeam[g.home] || ownerOfTeam[g.away])
  .map((g) => ({ id: g.id, week: g.week, slot: slot(g), postseason: g.seasonType === "postseason",
    home: g.home, away: g.away, date: g.date }))
  .sort((a, b) => a.slot - b.slot);

/* ---------- write ---------- */
const out = {
  generatedAt: new Date().toISOString(),
  season: YEAR,
  slot: currentSlot,
  league: {
    name: league.name, rounds: league.rounds, buyIn: league.buyIn,
    payouts: league.payouts, consolation: league.consolation,
    frozen: !!league.frozen, note: league.note,
  },
  owners, teams, upcoming, ownerOfTeam,
};

fs.mkdirSync(path.join(ROOT, "data"), { recursive: true });
fs.writeFileSync(path.join(ROOT, "data", "standings.json"), JSON.stringify(out));
console.log(`Wrote data/standings.json — through slot ${currentSlot}, leader ${owners[0].name} at ${owners[0].pct.toFixed(3)}.`);
