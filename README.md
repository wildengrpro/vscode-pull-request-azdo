# Review and manage existing Azure DevOps pull requests directly in VS Code

This extension is originally forked from [Azure Devops Pull Requests for Visual Studio Code](https://https://github.com/ankitbko/vscode-pull-request-azdo). The extension only works with _git_ based repository. _TFVC_ is not supported. Below are some the features that extension supports.

- Authenticating and connecting VS Code to Azure DevOps.
- Listing and browsing PRs from within VS Code.
- Reviewing PRs from within VS Code with in-editor commenting.
- Contributing to PRs while reviewing from within VS Code with easy checkouts.
- Suggest edits to the PR Author. Author can apply edits directly from Description page.
- Mark file as viewed when reviewing PR.
- Supports multiple repositories in the same workspace (i.e. multiroot workspace)
- Supports viewing Git LFS files in PRs without checkout (requires Git LFS extension to be installed)
- Comment functionality with Git LFS files such as PDF, images, and other binary files in PRs (requires PDF extension to be installed)

![PR Diff](documentation/images/pr_modified.jpg)
![PR Dashboard](documentation/images/pr_dashboard.jpg)

## Getting Started

It's easy to get started with Azure Devops Pull Requests for Visual Studio Code. Simply follow these steps to get started.

1. Make sure you have VSCode version 1.52.0 or higher.
1.
1. Reload VS Code after the installation (click the reload button next to the extension).
1. Open your desired Azure Devops repository.
1. (Optional) Extension will autodetect the Azure DevOps URL from git remote. In case it fails, you can configure the `azdoPullRequests.projectName` and `azdoPullRequests.orgUrl` setting. You can configure it in workspace settings and commit it so others in your team wouldn't need to do this configuration again. (Look at the next section to understand the format of these settings).
1. Signin to VS Code using same Microsoft account that you use to signin to Azure DevOps. Authentication will work automatically.

## Configuring the extension

#### azdoPullRequests.orgUrl

- _type_: string
- _required_: true
- _Description_: The organization URL of Azure Devops. You can get it from the URL of the Azure DevOps. This is typically the first segment of URL after host name in Azure Devops: `https://dev.azure.com/<org_name>` or `https://<org_name>.visualstudio.com`. You will need to enter the complete URL.
- _Example_: `https://dev.azure.com/wildengrpro` or `https://wildengrpro.visualstudio.com`

#### azdoPullRequests.projectName

- _type_: string
- _required_: false
- _Description_: The project name in Azure DevOps. This is typically the next segment of URL after organization name in Azure DevOps. `https://dev.azure.com/<org_name>/<project_name>` or `https://<org_name>.visualstudio.com/<project_name>`. **Do not enter the complete URL, you only need to enter the _project_name_ part**.  You can also leave this blank as the extension will try to auto-detect the project name from git remote URL, but if it fails to detect you will need to enter this value, in which case multiple repositories in the same workspace will not work as you can only enter one project name.
- _Example_: `prExtension`

#### azdoPullRequests.logLevel

- _type_: enum
- _required_: false
- _default_: Info
- _Description_: The level of log to display in AzDO Pull Request Channel in Output window.

#### azdoPullRequests.diffBase

- _type_: enum
- _required_: false
- _default_: mergebase
- _Description_: The commit to use to get diff against the PR branch's HEAD. Read more about different options in [wiki](https://github.com/wildengrpro/vscode-pull-request-azdo/wiki/Diff-Options-HEAD-vs-Merge-Base)

#### azdoPullRequests.patToken
- _type_: string
- _required_: false
- _default_: ""
- _Description_: The PAT Token from Azure DevOps, if provided extension will not prompt for Microsoft login instead it will login using provided PAT

## Known Major Issues

1. Mentions in comments are not resolved to user and no hover support
1. Can't mention users in comments
1. **Some incompatibility with Github PR Extension**. If you have both extensions installed and seeing issues with either try disabling the other extension and reloading the window.
1. In some cases, user avatar image does not show up in Dashboard.
1. Reactions do not work.

## Issues

Please submit issues here: [Issues](https://github.com/wildengrpro/vscode-pull-request-azdo/issues)

Please check the existing issues before submitting a new issue. If you are seeing an issue, please submit detailed steps to reproduce the issue along with screenshots and logs if possible.

## Contributing

If you are interested in contributing to the extension, please submit a pull request. Please make sure to follow the existing code style and add tests for any new functionality.
