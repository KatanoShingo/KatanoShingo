const fs = require("fs/promises");

const GITHUB_TOKEN = process.env.GH_PAT || process.env.GITHUB_TOKEN;
const USERNAME = process.env.GH_USERNAME || "KatanoShingo";
const OUTPUT = process.env.OUTPUT_FILE || "github-custom-card.svg";

if (!GITHUB_TOKEN) throw new Error("Missing token. Set GH_PAT or GITHUB_TOKEN.");

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
  if (!res.ok) throw new Error(`GraphQL request failed (${res.status}): ${await res.text()}`);
  const data = await res.json();
  if (data.errors?.length) throw new Error(`GraphQL errors: ${JSON.stringify(data.errors)}`);
  return data.data;
}

async function toDataUri(url) {
  const res = await fetch(url, { headers: { Authorization: `Bearer ${GITHUB_TOKEN}` } });
  if (!res.ok) throw new Error(`Avatar fetch failed (${res.status})`);
  const mime = res.headers.get("content-type") || "image/png";
  const buffer = Buffer.from(await res.arrayBuffer());
  return `data:${mime};base64,${buffer.toString("base64")}`;
}

function clamp(v, min, max) {
  return Math.max(min, Math.min(max, v));
}

function formatNum(v) {
  return new Intl.NumberFormat("ja-JP").format(v || 0);
}

function formatBytes(bytes) {
  const mb = (bytes || 0) / (1024 * 1024);
  if (mb >= 1024) return `${(mb / 1024).toFixed(1)} GB`;
  return `${mb.toFixed(1)} MB`;
}

function formatKB(kb) {
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

function yearsSince(dateIso) {
  const start = new Date(dateIso);
  const now = new Date();
  let years = now.getUTCFullYear() - start.getUTCFullYear();
  const notYetBirthday =
    now.getUTCMonth() < start.getUTCMonth() ||
    (now.getUTCMonth() === start.getUTCMonth() && now.getUTCDate() < start.getUTCDate());
  if (notYetBirthday) years -= 1;
  return Math.max(0, years);
}

function gradeRank(score) {
  if (score >= 95) return "S";
  if (score >= 88) return "A+";
  if (score >= 80) return "A";
  if (score >= 72) return "B+";
  if (score >= 64) return "B";
  if (score >= 56) return "C+";
  if (score >= 48) return "C";
  return "D";
}

async function fetchUserSummary() {
  const query = `
    query($login: String!) {
      user(login: $login) {
        login
        name
        avatarUrl(size: 96)
        createdAt
        followers { totalCount }
        following { totalCount }
        repositories(ownerAffiliations: OWNER, isFork: false, first: 1) { totalCount }
        repositoriesContributedTo(contributionTypes: [COMMIT, PULL_REQUEST, ISSUE], first: 1) { totalCount }
        pullRequests(states: [OPEN, MERGED, CLOSED]) { totalCount }
        issues(states: [OPEN, CLOSED]) { totalCount }
        issueComments { totalCount }
        organizations(first: 1) { totalCount }
        starredRepositories(first: 1) { totalCount }
        watching(first: 1) { totalCount }
        sponsorshipsAsMaintainer(first: 1) { totalCount }
        contributionsCollection {
          totalCommitContributions
          totalPullRequestReviewContributions
        }
      }
    }
  `;
  const data = await graphql(query, { login: USERNAME });
  return data.user;
}

async function fetchLanguageAndRepoStats() {
  const languageMap = new Map();
  let totalStars = 0;
  let totalForks = 0;
  let totalDiskUsageKB = 0;
  let after = null;

  const query = `
    query($login: String!, $after: String) {
      user(login: $login) {
        repositories(ownerAffiliations: OWNER, isFork: false, first: 100, after: $after, orderBy: {field: UPDATED_AT, direction: DESC}) {
          pageInfo { hasNextPage endCursor }
          nodes {
            stargazerCount
            forkCount
            diskUsage
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
      totalForks += repo.forkCount || 0;
      totalDiskUsageKB += repo.diskUsage || 0;
      for (const edge of repo.languages.edges || []) {
        const prev = languageMap.get(edge.node.name) || { size: 0, color: edge.node.color || "#8b949e" };
        prev.size += edge.size || 0;
        if (!prev.color && edge.node.color) prev.color = edge.node.color;
        languageMap.set(edge.node.name, prev);
      }
    }
    if (!repos.pageInfo.hasNextPage) break;
    after = repos.pageInfo.endCursor;
  }

  const totalLangSize = [...languageMap.values()].reduce((acc, x) => acc + x.size, 0);
  const topLanguages = [...languageMap.entries()]
    .map(([name, value]) => ({ name, ...value }))
    .sort((a, b) => b.size - a.size)
    .slice(0, 8)
    .map((lang) => ({ ...lang, percent: totalLangSize > 0 ? (lang.size / totalLangSize) * 100 : 0 }));

  return { topLanguages, totalStars, totalForks, totalDiskUsageKB, languageCount: languageMap.size };
}

function buildSvg(model) {
  const width = 920;
  const height = 560;
  const ringRadius = 52;
  const ringStroke = 11;
  const ringCirc = 2 * Math.PI * ringRadius;
  const ringProgress = clamp(model.score, 0, 100);
  const ringOffset = ringCirc * (1 - ringProgress / 100);

  const barWidth = 820;
  let cursorX = 50;
  const barY = 392;
  const segments = model.languages
    .map((lang) => {
      const w = Math.max(2, (lang.percent / 100) * barWidth);
      const frag = `<rect x="${cursorX.toFixed(2)}" y="${barY}" width="${w.toFixed(2)}" height="11" fill="${escapeXml(
        lang.color || "#8b949e"
      )}" rx="2"/>`;
      cursorX += w;
      return frag;
    })
    .join("");

  const languageRows = model.languages
    .slice(0, 8)
    .map((lang, i) => {
      const col = i % 2;
      const row = Math.floor(i / 2);
      const x = col === 0 ? 50 : 470;
      const y = 421 + row * 24;
      return `<circle cx="${x}" cy="${y}" r="4.5" fill="${escapeXml(lang.color || "#8b949e")}"/>
<text x="${x + 14}" y="${y + 5}" class="fg" font-size="15">${escapeXml(lang.name)}</text>
<text x="${x + 170}" y="${y + 5}" class="muted" font-size="14">${formatBytes(lang.size)}</text>
<text x="${x + 282}" y="${y + 5}" class="muted" font-size="14">${lang.percent.toFixed(2)}%</text>`;
    })
    .join("");

  return `<?xml version="1.0" encoding="UTF-8"?>
<svg xmlns="http://www.w3.org/2000/svg" width="${width}" height="${height}" viewBox="0 0 ${width} ${height}" role="img" aria-label="Shingo custom profile card">
  <defs>
    <linearGradient id="ring" x1="0" y1="0" x2="1" y2="1">
      <stop offset="0%" stop-color="#58a6ff"/>
      <stop offset="100%" stop-color="#f778ba"/>
    </linearGradient>
    <style>
      text { font-family: "Segoe UI", "Noto Sans JP", "Yu Gothic UI", sans-serif; }
      .primary { fill: #0969da; }
      .fg { fill: #24292f; }
      .muted { fill: #57606a; }
      .good { fill: #1a7f37; }
      .line { stroke: #d0d7de; }
      @media (prefers-color-scheme: dark) {
        .primary { fill: #58a6ff; }
        .fg { fill: #c9d1d9; }
        .muted { fill: #8b949e; }
        .good { fill: #7ee787; }
        .line { stroke: #30363d; }
      }
    </style>
  </defs>

  <rect x="10" y="10" width="${width - 20}" height="${height - 20}" rx="14" fill="none" class="line" stroke-width="2"/>

  <clipPath id="avatarClip"><circle cx="48" cy="48" r="23"/></clipPath>
  <image href="${escapeXml(model.avatarDataUri)}" x="25" y="25" width="46" height="46" clip-path="url(#avatarClip)"/>
  <text x="82" y="54" class="primary" font-size="28" font-weight="700">${escapeXml(model.displayName)}</text>
  <text x="82" y="78" class="muted" font-size="15">Joined ${model.githubYears}y ago（GitHub歴 ${model.githubYears}年）</text>
  <text x="450" y="78" class="muted" font-size="15">Followers（フォロワー）${formatNum(model.followers)} / Following（フォロー中）${formatNum(model.following)}</text>

  <!-- Top row: left Activity / right Community -->
  <rect x="28" y="96" width="414" height="240" rx="10" fill="none" class="line" stroke-width="1.5"/>
  <rect x="452" y="96" width="440" height="240" rx="10" fill="none" class="line" stroke-width="1.5"/>

  <text x="50" y="125" class="primary" font-size="24" font-weight="700">Activity（アクティビティ）</text>
  <text x="50" y="155" class="fg" font-size="15">• Commits（コミット）: ${formatNum(model.totalCommits)}</text>
  <text x="50" y="181" class="fg" font-size="15">• PR Opened（PR作成）: ${formatNum(model.totalPRs)}</text>
  <text x="50" y="207" class="fg" font-size="15">• PR Reviews（PRレビュー）: ${formatNum(model.totalReviews)}</text>
  <text x="50" y="233" class="fg" font-size="15">• Issues（課題）: ${formatNum(model.totalIssues)}</text>
  <text x="50" y="259" class="fg" font-size="15">• Comments（コメント）: ${formatNum(model.totalIssueComments)}</text>
  <text x="50" y="285" class="fg" font-size="15">• Watching（ウォッチ中）: ${formatNum(model.watching)}</text>

  <text x="474" y="125" class="primary" font-size="24" font-weight="700">Community（コミュニティ）</text>
  <text x="474" y="155" class="fg" font-size="15">• Contributed Repos（参加）: ${formatNum(model.contributedRepos)}</text>
  <text x="474" y="181" class="fg" font-size="15">• Owned Repos（所有）: ${formatNum(model.totalRepos)}</text>
  <text x="474" y="207" class="fg" font-size="15">• Stars Earned（獲得スター）: ${formatNum(model.totalStars)}</text>
  <text x="474" y="233" class="fg" font-size="15">• Forks Earned（獲得フォーク）: ${formatNum(model.totalForks)}</text>
  <text x="474" y="259" class="fg" font-size="15">• Starred（スター付け）: ${formatNum(model.starred)}</text>
  <text x="474" y="285" class="fg" font-size="15">• Orgs / Sponsors（組織/スポンサー）: ${formatNum(model.organizations)} / ${formatNum(model.sponsors)}</text>

  <text x="760" y="126" class="primary" font-size="19" font-weight="700">Rank（ランク）</text>
  <circle cx="790" cy="216" r="${ringRadius}" fill="none" class="line" stroke-width="${ringStroke}"/>
  <circle cx="790" cy="216" r="${ringRadius}" fill="none" stroke="url(#ring)" stroke-width="${ringStroke}" stroke-linecap="round"
    transform="rotate(-90 790 216)" stroke-dasharray="${ringCirc.toFixed(2)}" stroke-dashoffset="${ringOffset.toFixed(2)}"/>
  <text x="790" y="223" class="good" font-size="36" text-anchor="middle" font-weight="700">${escapeXml(model.rank)}</text>
  <text x="790" y="246" class="muted" font-size="13" text-anchor="middle">score ${model.score.toFixed(1)}</text>

  <!-- Bottom row: languages + metadata -->
  <text x="50" y="374" class="primary" font-size="24" font-weight="700">Top Languages（使用言語）</text>
  <rect x="50" y="${barY}" width="${barWidth}" height="11" fill="none" class="line" rx="6"/>
  ${segments}
  ${languageRows}

  <text x="50" y="544" class="muted" font-size="13">Disk Usage（使用量）: ${formatKB(model.totalDiskUsageKB)} / Languages（言語数）: ${formatNum(model.languageCount)} / Updated（更新）: ${new Date()
    .toISOString()
    .slice(0, 10)}</text>
  <text x="870" y="544" class="muted" font-size="13" text-anchor="end">generated by GitHub Actions</text>
</svg>`;
}

async function main() {
  const user = await fetchUserSummary();
  const repoStats = await fetchLanguageAndRepoStats();
  const avatarDataUri = await toDataUri(user.avatarUrl);

  const score =
    clamp(Math.log10((user.contributionsCollection.totalCommitContributions || 0) + 1) * 24, 0, 38) +
    clamp(Math.log10((user.pullRequests.totalCount || 0) + 1) * 18, 0, 23) +
    clamp(Math.log10((user.contributionsCollection.totalPullRequestReviewContributions || 0) + 1) * 16, 0, 21) +
    clamp(Math.log10((user.issues.totalCount || 0) + 1) * 10, 0, 12) +
    clamp(Math.log10((user.followers.totalCount || 0) + 1) * 8, 0, 10);

  const model = {
    displayName: user.name || user.login,
    avatarDataUri,
    githubYears: yearsSince(user.createdAt),
    followers: user.followers.totalCount || 0,
    following: user.following.totalCount || 0,
    contributedRepos: user.repositoriesContributedTo.totalCount || 0,
    totalCommits: user.contributionsCollection.totalCommitContributions || 0,
    totalPRs: user.pullRequests.totalCount || 0,
    totalReviews: user.contributionsCollection.totalPullRequestReviewContributions || 0,
    totalIssues: user.issues.totalCount || 0,
    totalIssueComments: user.issueComments.totalCount || 0,
    totalRepos: user.repositories.totalCount || 0,
    totalStars: repoStats.totalStars,
    totalForks: repoStats.totalForks,
    totalDiskUsageKB: repoStats.totalDiskUsageKB,
    languageCount: repoStats.languageCount,
    starred: user.starredRepositories.totalCount || 0,
    organizations: user.organizations.totalCount || 0,
    sponsors: user.sponsorshipsAsMaintainer.totalCount || 0,
    watching: user.watching.totalCount || 0,
    score,
    rank: gradeRank(score),
    languages: repoStats.topLanguages,
  };

  const svg = buildSvg(model);
  await fs.writeFile(OUTPUT, svg, "utf8");
  console.log(`Generated ${OUTPUT}`);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
