FROM oven/bun:1.2.22-debian

ARG AGENT_UID=1000
ARG AGENT_GID=1000

RUN apt-get update \
  && apt-get install -y --no-install-recommends git curl jq ca-certificates gh \
  && bun add --global @openai/codex \
  && groupadd --gid "${AGENT_GID}" agent \
  && useradd --uid "${AGENT_UID}" --gid "${AGENT_GID}" --create-home --shell /bin/bash agent \
  && rm -rf /var/lib/apt/lists/*

USER agent
WORKDIR /workspace

ENV CODEX_HOME=/home/agent/.codex-agent-train
