Shows a big green circle in the sidebar whenever an agent session needs your attention: finish, error, permission, or anything else.

Are you also a friend of long-running sessions, tired of staring at Paseo and waiting for the session to finish (or break) so you can give it the next prompt/kick — because you want to avoid IT WAITING FOR YOU? Me too ;))) Now this simple green circle helps you forget gazing and waiting — leave your screen for a break or a coffee; next time you glance at it, even meters away, you'll see whether it's your turn to prompt next.

The circle is deliberately huge (120px) — you'll spot it from the kitchen 🙂.
It watches the agent list on the connected host and shows the circle once per event, with the count of waiting sessions. Clicking the circle opens the most recent waiting session directly; each further click opens the next older one, cycling through all waiting sessions. Sending a new prompt in a session clears its entry. Sound is handled separately (for example by the public notification-sounds plugin); this plugin makes no sound itself.

Pair it with Ben Klingner's notification-sounds plugin for an audible ding alongside the green circle: `paseo plugin add benklingner/notification-sounds` (https://github.com/BenKlingner/notification-sounds).
