# Contributing to ZK LLM API (v2)

Thank you for your interest in contributing!

## About the Project

ZK LLM API provides anonymous, privacy-preserving LLM access using zero-knowledge proofs on Base. Built on [Scaffold-ETH 2](https://scaffoldeth.io) (Foundry flavor).

Read the [README](README.md) for a project overview.

## Getting Started

You can contribute in many ways:

- Solve open issues
- Report bugs or feature requests
- Improve documentation
- Add new features

### General Guidelines

- Search for existing Issues and PRs before creating your own
- Use the same formatting as the codebase (prettier/linting configs are included)
- If applicable, update documentation to reflect your changes

## Development Setup

```bash
git clone https://github.com/clawdbotatg/zkllmapi-v2
cd zkllmapi-v2
yarn install

# Frontend
yarn start

# Backend (requires .env — see README)
yarn backend:dev

# Contracts (local dev)
yarn chain
yarn deploy
```

See [README.md](README.md) for full environment setup and all available commands.

## Pull Request Process

1. Fork the repo
2. Create a new branch with a descriptive name
3. Make your changes
4. Ensure linting passes: `yarn lint`
5. Push and open a PR

### Tips

- Write a clear title and description
- Link related issues
- Keep PRs focused — one feature or fix per PR

## Project Structure

| Package | Purpose |
|---------|---------|
| `packages/nextjs` | Next.js frontend |
| `packages/foundry` | Solidity contracts (Foundry) |
| `packages/backend` | Express API server |
| `packages/proxy` | OpenAI-compatible proxy |
| `packages/circuits` | Noir ZK circuit |

See [AGENTS.md](AGENTS.md) for detailed architecture and code style guidance.

## License

MIT
