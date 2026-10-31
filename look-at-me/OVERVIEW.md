Shows a big green circle in the sidebar whenever an agent session needs your attention: finish, error, permission, or anything else.

It watches the agent list on the connected host and shows the circle once per event, with the count of waiting sessions. Clicking the circle opens the most recent waiting session directly; each further click opens the next older one, cycling through all waiting sessions. Sending a new prompt in a session clears its entry. Sound is handled separately (for example by the public notification-sounds plugin); this plugin makes no sound itself.
