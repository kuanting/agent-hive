import { defineConfig } from "vitepress";
import { withMermaid } from "vitepress-plugin-mermaid";

import { designChapters } from "./design-chapters.mjs";

const REPO = "https://github.com/kuanting/agent-hive";

/**
 * The Agent Hive documentation site.
 *
 * `docs/` is both the VitePress project root and its srcDir, which is doing
 * more work than it looks. It keeps `docs/DESIGN.md` exactly where it has
 * always been — so every relative link in README.md still resolves on
 * GitHub — and it excludes the two markdown families that must never be
 * published *structurally* rather than by a glob that someone has to remember
 * to maintain: `customers/*.plan-guide.md` (prompt configuration) and
 * `demo/personal-data/**` (fake personal data for the personal bee). Both live
 * outside srcDir, so there is no configuration to get wrong.
 */
export default withMermaid(
  defineConfig({
    title: "Agent Hive",
    description:
      "A multi-AI-agent management system built for token optimization: the Queen turns conversation into tasks and routes each one to the cheapest capability that can complete it.",

    // Both slashes are required. The site is served from a project subpath at
    // https://kuanting.github.io/agent-hive/ — without this every asset 404s,
    // and it only fails once deployed, never locally.
    base: "/agent-hive/",

    lang: "en-US",
    cleanUrls: true,

    // Reads git history for each page's timestamp, which is why CI checks out
    // with fetch-depth: 0. A shallow clone silently dates every page the same.
    lastUpdated: true,

    // The guide quotes the hive's own URLs — the console on :5180, the Queen on
    // :4100, RabbitMQ's management UI on :15672, Ollama on :11434. markdown-it
    // linkifies bare URLs, and VitePress then reports every one of them as a
    // dead link and fails the build. Ignore exactly that class and nothing
    // else, so genuine typos still break CI.
    ignoreDeadLinks: "localhostLinks",

    // Defence in depth only; the real exclusion is structural (see above).
    srcExclude: ["**/node_modules/**", "**/README.md"],

    sitemap: { hostname: "https://kuanting.github.io/agent-hive/" },

    markdown: {
      // DESIGN.md is one long page by design; per-heading anchors are how it
      // stays navigable and how search results deep-link into it.
      anchor: { level: [2, 3] },
    },

    themeConfig: {
      // nav/sidebar links omit `base` — VitePress prepends it. Only raw `head`
      // entries and raw HTML need it written out.
      nav: [
        { text: "Guide", link: "/guide/what-is-agent-hive", activeMatch: "/guide/" },
        { text: "Reference", link: "/reference/http-api", activeMatch: "/reference/" },
        { text: "Design", link: "/DESIGN" },
        { text: "Internals", link: "/internals/repo-layout", activeMatch: "/internals/" },
      ],

      sidebar: {
        "/guide/": [
          {
            text: "Introduction",
            items: [
              { text: "What is Agent Hive?", link: "/guide/what-is-agent-hive" },
              { text: "The four bees", link: "/guide/bees" },
              { text: "Prerequisites", link: "/guide/prerequisites" },
            ],
          },
          {
            text: "Running the hive",
            items: [
              { text: "Getting started (solo)", link: "/guide/getting-started" },
              { text: "Distributed with RabbitMQ", link: "/guide/distributed" },
              { text: "Multi-user with Open WebUI", link: "/guide/open-webui" },
              { text: "Watching work happen", link: "/guide/watching" },
              { text: "Stopping and resetting", link: "/guide/stopping" },
            ],
          },
          {
            text: "Concepts",
            items: [
              { text: "The capability ladder", link: "/guide/capability-ladder" },
              { text: "The conversational Queen", link: "/guide/planner" },
              { text: "A Queen that learns", link: "/guide/memory" },
              { text: "Budgets and dual currency", link: "/guide/budgets" },
            ],
          },
          {
            text: "Breeding",
            items: [
              { text: "Finding work a program could do", link: "/guide/breeding" },
              { text: "Reading what repeats", link: "/guide/breeding-survey" },
              { text: "Writing a tier-4 tool", link: "/guide/breeding-tools" },
            ],
          },
        ],

        "/reference/": [
          {
            text: "Reference",
            items: [
              { text: "HTTP API", link: "/reference/http-api" },
              { text: "Environment variables", link: "/reference/configuration" },
              { text: "Message protocol", link: "/reference/messages" },
              { text: "Worker config", link: "/reference/worker-config" },
              { text: "Customer policy", link: "/reference/customer-policy" },
              { text: "Usage corpus", link: "/reference/usage-corpus" },
              { text: "npm scripts", link: "/reference/scripts" },
              { text: "Glossary", link: "/reference/glossary" },
            ],
          },
        ],

        "/internals/": [
          {
            text: "Internals",
            items: [
              { text: "Repository layout", link: "/internals/repo-layout" },
              { text: "Package guide", link: "/internals/packages" },
            ],
          },
        ],

        // DESIGN.md is a single 63 KB page. This synthetic sidebar of anchors,
        // derived from the file's own `##` headings, makes it navigate like the
        // fourteen chapters it actually is — without splitting the file and
        // breaking its twenty-two plain-text "§N" cross-references or README's
        // four deep links to it.
        "/DESIGN": [
          {
            text: "Design",
            items: designChapters().map(({ text, anchor }) => ({
              text,
              link: `/DESIGN#${anchor}`,
            })),
          },
        ],
      },

      outline: [2, 3],

      search: { provider: "local" },

      socialLinks: [{ icon: "github", link: REPO }],

      editLink: {
        pattern: `${REPO}/edit/main/docs/:path`,
        text: "Edit this page on GitHub",
      },

      footer: {
        message:
          "Agent Hive — routing every task to the cheapest capability that can do it.",
      },
    },

    // mermaid pulls in d3, dayjs and cytoscape, none of which survive VitePress's
    // SSR prerender pass unbundled. withMermaid() handles the common path; these
    // three lines cover the ESM-interop failures that otherwise only appear
    // during `vitepress build`, never during `dev`.
    vite: {
      optimizeDeps: { include: ["mermaid"] },
      ssr: { noExternal: ["mermaid"] },
    },
  }),
);
