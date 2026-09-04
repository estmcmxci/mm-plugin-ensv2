import { defineConfig } from 'vocs/config'

// Deployed to a subdomain of estmcmxci.co (name chosen at DNS time). Cloudflare
// Pages exposes CF_PAGES_URL for previews; SITE_URL pins production.
// Only set in real deployments: Vocs emits <base href> from it, which breaks local preview.
const baseUrl = process.env.SITE_URL ?? process.env.CF_PAGES_URL

export default defineConfig({
  title: 'mm-plugin-ensv2',
  titleTemplate: '%s · mm-plugin-ensv2',
  description:
    'ENSv2 names and ERC-8004 agent identity for the MetaMask Agent Wallet CLI. Sepolia beta. Fail-closed, key-less, verified live.',
  baseUrl,
  renderStrategy: 'full-static',
  // Links to public/ files (/agents/*.json) and the build-time /llms.txt are outside the page graph.
  checkDeadlinks: 'warn',
  logoUrl: { light: '/mark-light.svg', dark: '/mark-dark.svg' },
  iconUrl: { light: '/mark-light.svg', dark: '/mark-dark.svg' },
  // Grayscale, like estmcmxci.co: g7 in light, warm dark-g7 in dark.
  accentColor: 'light-dark(#3f4649, #baa994)',
  colorScheme: 'light dark',
  codeHighlight: { themes: { light: 'github-light', dark: 'github-dark-dimmed' } },
  editLink: {
    link: 'https://github.com/estmcmxci/mm-plugin-ensv2/edit/main/site/src/pages/:path',
    text: 'Edit this page on GitHub',
  },
  socials: [{ icon: 'github', link: 'https://github.com/estmcmxci/mm-plugin-ensv2' }],
  topNav: [
    { text: 'Install', link: '/install' },
    { text: 'Commands', link: '/reference/commands' },
    { text: 'Evidence', link: '/evidence' },
    { text: 'npm', link: 'https://www.npmjs.com/package/@estmcmxci/mm-plugin-ensv2', external: true },
    { text: '𝔪✶', link: 'https://estmcmxci.co', external: true },
  ],
  sidebar: [
    {
      text: 'Start',
      items: [
        { text: 'What this is', link: '/' },
        { text: 'Install', link: '/install' },
        { text: 'Quickstart: a name, an agent, a primary name', link: '/quickstart' },
        { text: 'For agents', link: '/agents' },
      ],
    },
    {
      text: 'Explainer',
      items: [
        { text: 'ENSv2 in five minutes', link: '/explainer/ensv2' },
        { text: "Your wallet's resolver", link: '/explainer/resolver' },
        { text: 'Registering a name', link: '/explainer/registration' },
        { text: 'Agent identity: ERC-8004 and ENSIP-25/26', link: '/explainer/identity' },
        { text: 'Primary names', link: '/explainer/primary-name' },
        { text: 'Durable jobs', link: '/explainer/jobs' },
      ],
    },
    {
      text: 'Reference',
      items: [
        { text: 'Commands', link: '/reference/commands' },
        { text: 'Error codes', link: '/reference/errors' },
        { text: 'Deployment table', link: '/reference/deployment' },
        { text: 'Design: fail closed', link: '/reference/design' },
      ],
    },
    {
      text: 'Evidence',
      items: [{ text: 'Live on Sepolia', link: '/evidence' }],
    },
  ],
})
