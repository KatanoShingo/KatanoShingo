const fs = require("fs/promises");

const GITHUB_TOKEN = process.env.GH_PAT || process.env.GITHUB_TOKEN;
const USERNAME = process.env.GH_USERNAME || "KatanoShingo";
const OUTPUT = process.env.OUTPUT_FILE || "github-custom-card.svg";

if (!GITHUB_TOKEN) {
  throw new Error("Missing token. Set GH_PAT or GITHUB_TOKEN.");
}

async function graphql(query, variables = {}) {
  const res = await fetch("https://api.github.com/graphql", {
    method: "POST",
    headers: {
      Authorization: `Bearer ${GITHUB_TOKEN}`,
      "Content-Type": "application/json",
      "User-Agent": "profile-card-generator",
    },
    body: JSON.stringify({ query, variables }),
  });

  if (!res.ok) {
    const body = await res.text();
    throw new Error(`GraphQL request failed (${res.status}): ${body}`);
  }

  const data = await res.json();
  if (data.errors?.length) {
    throw new Error(`GraphQL errors: ${JSON.stringify(data.errors)}`);
  }
  return data.data;
}

function gradeRank(score) {
  if (score >= 95) return "S";
  if (score >= 85) return "A+";
  if (score >= 75) return "A";
  if (score >= 65) return "B+";
  if (score >= 55) return "B";
  if (score >= 45) return "C+";
  if (score >= 35) return "C";
  return "D";
}

function clamp(n, min, max) {
  return Math.max(min, Math.min(max, n));
}

function formatNum(value) {
  return new Intl.NumberFormat("en-US").format(value || 0);
}

function formatBytes(kb) {
  const mb = (kb || 0) / 1024;
  if (mb >= 1024) return `${(mb / 1024).toFixed(1)} GB`;
  return `${mb.toFixed(1)} MB`;
}

function escapeXml(value) {
  return String(value)
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&apos;");
}

async function fetchUserAndContributions() {
  const query = `
    query($login: String!) {
      user(login: $login) {
        login
        name
        avatarUrl(size: 72)
        followers { totalCount }
        repositories(ownerAffiliations: OWNER, isFork: false, first: 1) { totalCount }
        repositoriesContributedTo(contributionTypes: [COMMIT, PULL_REQUEST, ISSUE], first: 1) { totalCount }
        pullRequests(states: [OPEN, MERGED, CLOSED]) { totalCount }
        issues(states: [OPEN, CLOSED]) { totalCount }
        contributionsCollection {
          totalCommitContributions
        }
      }
    }
  `;
  const data = await graphql(query, { login: USERNAME });
  return data.user;
}

async function fetchLanguageStats() {
  const languageMap = new Map();
  let totalStars = 0;
  let after = null;

  const query = `
    query($login: String!, $after: String) {
      user(login: $login) {
        repositories(ownerAffiliations: OWNER, isFork: false, first: 100, after: $after, orderBy: {field: UPDATED_AT, direction: DESC}) {
          pageInfo { hasNextPage endCursor }
          nodes {
            stargazerCount
            languages(first: 10, orderBy: {field: SIZE, direction: DESC}) {
              edges {
                size
                node { name color }
              }
            }
          }
        }
      }
    }
  `;

  while (true) {
    const data = await graphql(query, { login: USERNAME, after });
    const repos = data.user.repositories;
    for (const repo of repos.nodes || []) {
      totalStars += repo.stargazerCount || 0;
      for (const edge of repo.languages.edges || []) {
        const key = edge.node.name;
        const prev = languageMap.get(key) || { size: 0, color: edge.node.color || "#8b949e" };
        prev.size += edge.size || 0;
        if (!prev.color && edge.node.color) prev.color = edge.node.color;
        languageMap.set(key, prev);
      }
    }
    if (!repos.pageInfo.hasNextPage) break;
    after = repos.pageInfo.endCursor;
  }

  const total = [...languageMap.values()].reduce((acc, item) => acc + item.size, 0);
  const top = [...languageMap.entries()]
    .map(([name, value]) => ({ name, ...value }))
    .sort((a, b) => b.size - a.size)
    .slice(0, 6)
    .map((x) => ({
      ...x,
      percent: total > 0 ? (x.size / total) * 100 : 0,
    }));

  return { top, totalSize: total, totalStars };
}

function buildSvg(model) {
  const width = 880;
  const height = 390;
  const ringRadius = 56;
  const ringStroke = 12;
  const ringCircumference = 2 * Math.PI * ringRadius;
  const ringProgress = clamp(model.score, 0, 100);
  const dashOffset = ringCircumference * (1 - ringProgress / 100);

  const totalBarWidth = 760;
  let barX = 60;
  const barY = 280;

  const languageSegments = model.languages
    .map((lang) => {
      const widthPart = (lang.percent / 100) * totalBarWidth;
      const seg = `<rect x="${barX.toFixed(2)}" y="${barY}" width="${widthPart.toFixed(2)}" height="12" fill="${escapeXml(
        lang.color || "#8b949e"
      )}" rx="2" ry="2" />`;
      barX += widthPart;
      return seg;
    })
    .join("");

  const languageRows = model.languages
    .map((lang, idx) => {
      const col = idx % 2;
      const row = Math.floor(idx / 2);
      const x = col === 0 ? 60 : 450;
      const y = 320 + row * 22;
      return `
      <circle cx="${x}" cy="${y}" r="5" fill="${escapeXml(lang.color || "#8b949e")}" />
      <text x="${x + 14}" y="${y + 5}" fill="#c9d1d9" font-size="18">${escapeXml(lang.name)}</text>
      <text x="${x + 170}" y="${y + 5}" fill="#8b949e" font-size="16">${formatBytes(lang.size / 1024)}</text>
      <text x="${x + 270}" y="${y + 5}" fill="#8b949e" font-size="16">${lang.percent.toFixed(2)}%</text>
      `;
    })
    .join("");

  return `<?xml version="1.0" encoding="UTF-8"?>
<svg xmlns="http://www.w3.org/2000/svg" width="${width}" height="${height}" viewBox="0 0 ${width} ${height}" role="img" aria-label="Custom GitHub profile card">
  <defs>
    <linearGradient id="bg" x1="0" y1="0" x2="1" y2="1">
      <stop offset="0%" stop-color="#0d1117"/>
      <stop offset="100%" stop-color="#161b22"/>
    </linearGradient>
    <linearGradient id="ring" x1="0" y1="0" x2="1" y2="1">
      <stop offset="0%" stop-color="#58a6ff"/>
      <stop offset="100%" stop-color="#f778ba"/>
    </linearGradient>
    <style>
      text { font-family: "Segoe UI", Ubuntu, Sans-Serif; }
    </style>
  </defs>

  <rect x="8" y="8" width="${width - 16}" height="${height - 16}" rx="14" fill="url(#bg)" stroke="#30363d" stroke-width="2"/>
  <image href="${escapeXml(model.avatarUrl)}" x="34" y="28" width="44" height="44" clip-path="inset(0 round 22px)" />
  <text x="90" y="58" fill="#58a6ff" font-size="38" font-weight="700">${escapeXml(model.username)}</text>
  <text x="60" y="104" fill="#8b949e" font-size="22">Followers ${formatNum(model.followers)}   •   Contributed repos ${formatNum(
    model.contributedRepos
  )}</text>

  <text x="60" y="148" fill="#7ee787" font-size="30" font-weight="700">Activity</text>
  <text x="60" y="182" fill="#c9d1d9" font-size="24">Commits: ${formatNum(model.totalCommits)}</text>
  <text x="60" y="212" fill="#c9d1d9" font-size="24">Pull Requests: ${formatNum(model.totalPRs)}</text>
  <text x="60" y="242" fill="#c9d1d9" font-size="24">Issues: ${formatNum(model.totalIssues)}</text>
  <text x="450" y="182" fill="#c9d1d9" font-size="24">Repositories: ${formatNum(model.totalRepos)}</text>
  <text x="450" y="212" fill="#c9d1d9" font-size="24">Stars: ${formatNum(model.totalStars)}</text>

  <text x="640" y="148" fill="#79c0ff" font-size="28" font-weight="700">Rank</text>
  <circle cx="720" cy="208" r="${ringRadius}" fill="none" stroke="#30363d" stroke-width="${ringStroke}" />
  <circle
    cx="720"
    cy="208"
    r="${ringRadius}"
    fill="none"
    stroke="url(#ring)"
    stroke-width="${ringStroke}"
    stroke-linecap="round"
    transform="rotate(-90 720 208)"
    stroke-dasharray="${ringCircumference.toFixed(2)}"
    stroke-dashoffset="${dashOffset.toFixed(2)}"
  />
  <text x="720" y="214" fill="#a5f3fc" font-size="34" text-anchor="middle" font-weight="700">${escapeXml(model.rank)}</text>
  <text x="720" y="240" fill="#8b949e" font-size="14" text-anchor="middle">score ${model.score.toFixed(1)}</text>

  <text x="60" y="265" fill="#58a6ff" font-size="26" font-weight="700">Top Languages</text>
  <rect x="60" y="${barY}" width="${totalBarWidth}" height="12" fill="#21262d" rx="6" ry="6"/>
  ${languageSegments}
  ${languageRows}

  <text x="820" y="372" fill="#6e7681" font-size="12" text-anchor="end">Updated ${new Date().toISOString().slice(0, 10)}</text>
</svg>`;
}

async function main() {
  const user = await fetchUserAndContributions();
  const languageStats = await fetchLanguageStats();

  const score =
    clamp(Math.log10((user.contributionsCollection.totalCommitContributions || 0) + 1) * 22, 0, 40) +
    clamp(Math.log10((user.pullRequests.totalCount || 0) + 1) * 18, 0, 25) +
    clamp(Math.log10((user.issues.totalCount || 0) + 1) * 12, 0, 15) +
    clamp(Math.log10((user.followers.totalCount || 0) + 1) * 14, 0, 20);

  const totalStars = languageStats.totalStars;
  const model = {
    username: user.name || user.login,
    avatarUrl: user.avatarUrl,
    followers: user.followers.totalCount || 0,
    contributedRepos: user.repositoriesContributedTo.totalCount || 0,
    totalCommits: user.contributionsCollection.totalCommitContributions || 0,
    totalPRs: user.pullRequests.totalCount || 0,
    totalIssues: user.issues.totalCount || 0,
    totalRepos: user.repositories.totalCount || 0,
    totalStars,
    score,
    rank: gradeRank(score),
    languages: languageStats.top,
  };

  const svg = buildSvg(model);
  await fs.writeFile(OUTPUT, svg, "utf8");
  console.log(`Generated ${OUTPUT}`);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
