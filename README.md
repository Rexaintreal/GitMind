# GitMind

**GitMind** is a background AI agent that auto-commits your code while you stay in flow. It watches your codebase, detects changes, and generates clean commit messages using a local or remote LLM. No more messy git history — just consistent, meaningful commits with zero effort.

---

## What It Does

Most developers commit in bursts often at the end of a session, with vague messages like "fix stuff" or "wip". GitMind solves this by running silently in the background, monitoring your files, and committing at regular intervals with AI-generated messages that actually describe what changed.

You write code. GitMind handles the rest.

---

## Features

- Automatic commits at configurable time intervals
- AI-generated commit messages based on actual code diffs
- Toggle auto-commit on or off without leaving VS Code
- Status bar integration showing agent state at a glance
- Sidebar panel with commit controls and output
- Terminal echo for real-time commit logs
- Works with any git-initialized repository

---

## Architecture

GitMind has two components that work together:

**Agent (Python)**
The core engine. It watches your working directory for changes, diffs the current state against the last commit, calls an LLM with the diff, and runs `git commit` with the generated message. Runs as a background process managed by the extension.

**Extension (TypeScript)**
The VS Code interface. Provides the sidebar, status bar indicator, command palette entries, and terminal output. Communicates with the Python agent to start/stop auto-commit and configure settings like the commit interval.

---

## Installation

### VS Code Extension

Install directly from the Visual Studio Code Marketplace:

```
ext install saurabhtiwari.gitmind
```

Or search for **GitMind** in the Extensions panel inside VS Code.

Marketplace link: [https://marketplace.visualstudio.com/manage/publishers/saurabhtiwari/extensions/gitmind/hub](https://marketplace.visualstudio.com/manage/publishers/saurabhtiwari/extensions/gitmind/hub)

### Python Agent

The agent runs locally and requires Python 3.8 or higher.

```bash
cd Agent
pip install -r requirements.txt
```

Make sure the repository you want to track is initialized with git before starting the agent.

---

## Usage

1. Open your project folder in VS Code.
2. Activate the GitMind extension from the sidebar or command palette.
3. Set your preferred commit interval (default is configurable via extension settings).
4. Toggle auto-commit on.

GitMind will begin watching your files. Each time the interval elapses and there are uncommitted changes, it will generate a commit message and commit automatically.

You can turn auto-commit off at any time from the status bar or command palette without stopping the agent entirely.

---

## Configuration

| Setting | Description | Default |
|---|---|---|
| Commit interval | How often GitMind checks for changes and commits (in minutes) | Configurable |
| Auto-commit | Enable or disable automatic commits | On |
| LLM provider | The model used to generate commit messages | Configured in `llm.py` |

The Python agent reads its LLM configuration from `Agent/llm.py`. You can point it at any OpenAI-compatible API or local model.

---

## Project Structure

```
GitMind/
├── Agent/               # Python background agent
│   └── llm.py           # LLM integration and commit logic
├── Extension/
│   └── gitmind/         # VS Code extension (TypeScript)
│       ├── src/         # Extension source
│       └── package.json
├── package.json
└── LICENSE
```

---

## Requirements

- Git installed and available in PATH
- A git-initialized repository
- Python 3.8+ (for the agent)
- VS Code 1.75+ (for the extension)
- An LLM API key or local model endpoint configured in `llm.py`

---

## Contributing

Pull requests are welcome. If you find a bug or want to request a feature, open an issue and describe what you have in mind.

1. Fork the repository
2. Create a feature branch (`git checkout -b feature/your-feature`)
3. Commit your changes
4. Push and open a pull request

---

## Origin

GitMind was built in 24 hours at **Hack4Good**, a hackathon hosted at [CubiSpace](https://cubispace.in), Lucknow on May 2–3, 2026. Four people, one night, zero auto-commits before it existed.

Demo video: [Watch on Google Drive](#)

Full project documentation and design notes are available on Notion:
[https://www.notion.so/GitMind-e37ce3703abb4e058ad92b513bce62be](https://www.notion.so/GitMind-e37ce3703abb4e058ad92b513bce62be)

---

## Team

| Name | GitHub |
|---|---|
| Saurabh Tiwari | [@Rexaintreal](https://github.com/Rexaintreal) |
| Sujal Negi | [@sujalnegi](https://github.com/sujalnegi) |
| Baqar Mustafa | [@baqar08](https://github.com/baqar08) |
| Taksh Singh | [@takshsingh313](https://github.com/takshsingh313) |

---

## License

This project is licensed under the MIT License. See [LICENSE](LICENSE) for details.
