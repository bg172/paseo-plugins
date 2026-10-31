# Look at me

Big green circle in the Paseo sidebar whenever an agent session needs your
attention: finish, error, permission, or anything else.

Clicking the circle opens the most recent waiting session directly; each
further click opens the next older one, cycling through all waiting sessions.
Sending a new prompt in a session clears its entry. Sound is handled
separately (for example by a notification-sounds plugin); this plugin makes
no sound itself.

## Install

Turn on **Settings → Plugins → Enable plugins** on the Paseo daemon host,
then:

```sh
paseo plugin add git:bg172/paseo-plugins --path look-at-me
```

Pair it with Ben Klingner's notification-sounds plugin for an audible ding alongside the green circle: `paseo plugin add benklingner/notification-sounds` (https://github.com/BenKlingner/notification-sounds).
