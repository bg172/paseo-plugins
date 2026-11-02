# Paseo plugins

Plugins for [Paseo](https://paseo.sh). Each plugin lives in its own directory and can be installed independently.

| Plugin | What it adds |
| --- | --- |
| <img src="https://raw.githubusercontent.com/bg172/paseo-plugins/main/look-at-me/icon.png" alt="" width="24" height="24" align="center"> [look-at-me](look-at-me/README.md) | Big green circle in the sidebar whenever a session needs attention; click to jump straight to the most recent waiting session. |

## Install

Turn on **Settings → Plugins → Enable plugins** on the Paseo daemon host. Run the install command in each plugin's README. Plugin code is trusted and unsandboxed: server code runs as the daemon user, client code runs inside Paseo.
