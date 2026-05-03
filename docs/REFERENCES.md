# References

Useful projects and documents to learn from:

- Claude Code hooks documentation: https://docs.claude.com/en/docs/claude-code/hooks
- Claude Code MCP documentation: https://docs.claude.com/en/docs/claude-code/mcp
- Model Context Protocol security best practices: https://modelcontextprotocol.io/docs/tutorials/security/security_best_practices
- Model Context Protocol authorization specification: https://modelcontextprotocol.io/specification/2025-03-26/basic/authorization
- CCNotify: https://github.com/dazuiba/CCNotify
- code-notify: https://github.com/mylee04/code-notify
- Polymarket API documentation: https://docs.polymarket.com/api-reference

Design takeaways:

- Keep upstream integrations thin.
- Prefer official extension points over patching app internals.
- Use localhost and SSH tunnels for cross-machine notification routing.
- Treat hardware devices as notification consumers, not as the source of truth.
- Keep an internal notification queue so multiple consumers can read and acknowledge the same events.
