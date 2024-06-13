Fetch PRs by organization team name and display pertinant details

![Example Screenshot](./example-screenshot.png)

## Features
* Quickly fetch from hundreds of repos the PR information in under 2 seconds
* Display created at time, branch, author, build/commit status, url, title and  comment/review timeline events
* Poll for PR information on a specified interval
* Fetch all the repository names for which a github team has ADMIN permission in a given organization
* No backend needed. Everything runs in the browser. Configuration is stored in local storage

## Configuration
* `PR_RADIATOR_TOKEN`: Github Personal Access Token (https://github.com/settings/tokens)
  * `read:org, repo` scopes needed and SSO for organization needs to be enabled
* `PR_RADIATOR_REPOS`: Array of strings of the repository names to query
* `PR_RADIATOR_TEAM`: Github team (used to fetch the repository names)
* `PR_RADIATOR_ORGANIZATION`: Github organization
* `PR_RADIATOR_IGNORE_REPOS`: Array of strings of the repos to ignore
* `PR_RADIATOR_POLLING_INTERVAL`: Interval (milliseconds) to poll github for PR information
