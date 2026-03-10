# companion-grind

Explicit grind mode for companion.

Features:

- Auto-activates only when the user uses explicit grind cues in a prompt
- Persists run state in session custom entries
- Continues work on a heartbeat while running in `companion daemon`
- Pauses automatically when the user sends a normal prompt

Example prompts:

- `Keep going on this until 5pm`
- `Don't stop until the refactor is done`

Commands:

- `/grind start --until "5pm" Ship the refactor`
- `/grind status`
- `/grind pause`
- `/grind resume`
- `/grind stop`

Settings:

```json
{
  "companion-grind": {
    "enabled": true,
    "pollIntervalMs": 30000,
    "cueMode": "explicit-only",
    "requireDaemon": true,
    "userIntervention": "pause",
    "cuePatterns": [
      "don't stop",
      "keep going",
      "keep running",
      "run until",
      "until done",
      "stay on this until"
    ]
  }
}
```
