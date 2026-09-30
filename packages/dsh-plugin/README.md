# DSH Desktop Host plugin

This package runs only in official DeepSeek Harness Desktop `0.2.0-rc.2`. It uses injected `sessionController` and `workspaceRegistry` services and publishes an authenticated loopback endpoint for the separate MCP package.

Install it through Desktop's Plugins page with an absolute built package-directory or external tarball path. A first install should report `application: "applied"` through HMR. Package replacement or edits to an already installed source may require an operator-owned Desktop restart.

The JavaScript bundle includes the private bridge protocol runtime. Desktop-owned Cordis, Schemastery, session-controller, and Workspace capabilities remain exact external peers supplied by the Host. Delegation reuses an existing Workspace whose title matches the canonical task directory name, or creates an ungrouped Session at that directory in the default section. It never registers a Workspace. See the repository README for configuration, security, and acceptance cases.
