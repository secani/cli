# Security

Please report a vulnerability in the Secani CLI privately, through GitHub's **Report a vulnerability** button on this repository's Security tab, rather than as an issue. Include what an attacker could do, the steps to reproduce it, and the version of the CLI.

The CLI stores its login in the CLI config directory (`~/.config/secani/auth.json`, or `SECANI_CONFIG_DIR`), readable only by your user. It never prints access or refresh tokens.
