Fetch PRs by organization team name and display pertinent details

![Example Screenshot](./example-screenshot.png)

## Features
* Quickly fetch from hundreds of repos the PR information in under 2 seconds
* Display created at time, branch, author, build/commit status, url, title and comment/review timeline events
* View open PRs, merged PRs (last 25 per repo), and repository list
* Vim/magit-style keyboard navigation (j/k, gg/G, mnemonic view switching)
* Filter by Dependabot PRs and review status
* Fetch all the repository names for which a github team has ADMIN permission in a given organization
* No backend needed. Everything runs in the browser. Configuration is stored in local storage

## Keyboard Shortcuts
* **o** - Open PRs view
* **m** - Merged PRs view
* **l** - Repository list view
* **j/k** - Navigate down/up
* **gg** - Jump to first item
* **G** - Jump to last item
* **Enter** - Open selected item
* **i** - Toggle ignore repository (repo view)
* **d** - Toggle Dependabot PRs filter
* **n** - Toggle Needs Review filter
* **r** - Refresh current view
* **?** - Toggle keyboard shortcuts help

## Configuration
* `PR_RADIATOR_TOKEN`: Github Personal Access Token (https://github.com/settings/tokens)
  * `read:org, repo` scopes needed and SSO for organization needs to be enabled
* `PR_RADIATOR_REPOS`: Array of strings of the repository names to query
* `PR_RADIATOR_TEAM`: Github team (used to fetch the repository names)
* `PR_RADIATOR_ORGANIZATION`: Github organization
* `PR_RADIATOR_IGNORE_REPOS`: Array of strings of the repos to ignore
