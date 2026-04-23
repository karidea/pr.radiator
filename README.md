Fast, local, keyboard-first GitHub PR dashboard for organization teams.

![Example Screenshot](./example-screenshot.png)

## Features
* Open PRs, merged PRs, and repository views
* Mnemonic keyboard navigation and filters
* GitHub team-based repository discovery
* Browser-only setup with local configuration

## Keyboard Shortcuts

### Views
* **o** - Open PRs view
* **m** - Merged PRs view
* **l** - Repository list view
* **x** - External merges view

### Filters
* **d** - Toggle Dependabot PRs filter
* **n** - Toggle Needs Review filter
* **t** - Cycle team scope

### Navigation
* **j/k** - Navigate down/up
* **gg** - Jump to first item
* **G** - Jump to last item
* **Enter** - Open selected item

### Actions
* **i** - Toggle ignore repository (repo view)
* **r** - Refresh current view
* **R** - Refresh configured team repositories
* **c** - Open configuration
* **?** - Toggle keyboard shortcuts help

## External Merges View (`x`)
Shows PRs merged to **any branch** of the configured repositories by authors who are **not** members of the configured teams. Useful for tracking community or external contributions since a given date.

* Defaults to the start of the current year; date can be changed with the date picker in the header
* Displays a total summary, per-repository breakdown (total / external / internal / bots), and a list of external PRs grouped by repository
* Team member lists are fetched from GitHub and cached locally for 1 hour; press **R** to force a full refresh
* Respects team scope cycling (**t**) to narrow repositories; internal logins always include members of all configured teams
* Press **r** to reload data for the current date and scope


* `PR_RADIATOR_TOKEN`: Github Personal Access Token (https://github.com/settings/tokens)
  * `read:org, repo` scopes needed and SSO for organization needs to be enabled
* `PR_RADIATOR_OWNER`: Github organization
* `PR_RADIATOR_TEAMS`: Array of team slugs
* `PR_RADIATOR_REPOS`: Array of objects in the shape `{ slug, repos }`
* `PR_RADIATOR_IGNORE_REPOS`: Array of strings of the repos to ignore
