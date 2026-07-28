# Isolated Conversation workspaces

Each Conversation freezes a base commit and model profile, then works on one
Prtisan-managed branch and worktree inside Docker. Successful Turns become
checkpoint commits and publication pushes that branch into at most one pull
request; host and GitHub actions remain typed proposals requiring operator
confirmation. This preserves Prtisan's Sandcastle safety boundary while adding
resumable interactive agents and concurrent threads.
