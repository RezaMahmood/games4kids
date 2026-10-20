# How to bootstrap games4kids

This runbook takes you from an empty tenant to a first deploy. It replaces the manual morning checklist from PR #4. You run it once, on your Mac, and again after the first deploy.

`tools/bootstrap.mjs` does the work. It reads what exists, compares it with the goal in [ARCHITECTURE.md](ARCHITECTURE.md#bootstrap), and changes only the difference. `--plan` is the default and makes no change. A second `--apply` prints `No changes.`

## Before you start

- Sign in with `az login` as the account that is Owner of the subscription and Global Administrator of the tenant. Run `az account show` and confirm the subscription.
- Sign in with `gh auth login` as an admin of `RezaMahmood/games4kids`.
- Use Node 22.18 or later, and run `npm ci --ignore-scripts` in the checkout.
- Check out the `phase-6-bootstrap` branch. The script is not on `main` yet, and you run it before the merges so the first push to `main` finds its environments.

## Run the bootstrap

1. Read the plan. Pass the address that should receive the daily-cap alert.

	```
	node tools/bootstrap.mjs --plan --alert-email you@example.com
	```

2. Check the first lines. They name the subscription, the tenant, and the account you are signed in as. Check the federated credential subjects. This repository issues the immutable form, so the plan shows `repo:RezaMahmood@641491/games4kids@1426024915:environment:infra` and not the name form.

3. Apply the steps that need no admin account.

	```
	node tools/bootstrap.mjs --apply --alert-email you@example.com
	```

4. Create the account you administer from. The script asks for its UPN, which must be in a verified domain of the tenant. It creates the account with a random password that it never prints or stores.

	```
	node tools/bootstrap.mjs --apply --create-admin-account
	```

5. In the Entra admin center, open the new user and choose **Reset password**. Copy the temporary password from the dialog, sign in once as that user, and set a real password.

6. Run the verify table.

	```
	node tools/bootstrap.mjs --verify --create-admin-account --admin-upn <upn> --alert-email you@example.com
	```

	Every row says `PASS` except the `TODO` rows for B4, B5 and B6. Those are build checks only a person can run, and the section below lists them.

## Merge and deploy

1. Merge the stack bottom-up: PR #2, then #3, then #4. After each merge, change the next PR's base to `main`. Merging #4 adds `deploy.yml`, and its push starts the first deploy.
2. If that run deploys less than everything, start a full one.

	```
	gh workflow run deploy.yml
	```

3. Watch the `infra` job. It creates the two Static Web Apps and the portal storage account. Role assignments can take up to 30 minutes to reach a new resource, and the deploy retries a 403 for that long.
4. If `azure/login` fails with `AADSTS700213`, compare the subject in the error with the one in the plan. If they differ, re-run bootstrap with `--subject-form name` or `--subject-form id` to match what the job presented.

## After the first deploy

The sites and the portal account exist now. Run bootstrap again.

```
node tools/bootstrap.mjs --apply --after-first-deploy
```

This adds both sites' redirect URIs (`/` and `/redirect.html`) to the registrations, gives you Storage Table Data Contributor on the `admins` table only, and writes the admin account's `admins` row. It also gives `func-g4k-letterjoin` Cognitive Services User on the old letterjoin's Vision account `cv-letterjoin-ul5nga`, which games4kids borrows until letterjoin's data has moved, because the subscription may hold only one free Vision account. Pass `--seed-self` instead of creating an admin account if B5 fails and you fall back to administering as yourself.

Run `node tools/bootstrap.mjs --apply` once more. It must print `No changes.`

## Build checks to run by hand

The script cannot run these, because each needs a sign-in as the admin account.

- **B4.** A token from the elevation popup carries `auth_time`, and a silently refreshed `admin.console` token carries the old value.
- **B5.** The admin account's Cloud Application Administrator role, scoped to the games4kids service principal, can POST and DELETE an assignment on games4kids and is refused on another app. If it fails, administer from your Global Administrator account (see [Who you are when you administer](ARCHITECTURE.md#who-you-are-when-you-administer)).
- **B6.** `findUser` finds one real existing guest under `User.ReadBasic.All`, including through `otherMails`, and a sync for that guest sends no invitation.
- **B7.** A run of `deploy.yml` from a branch cannot enter `infra` or `deploy`.

## Options

| Option | Effect |
| --- | --- |
| `--plan`, `--apply`, `--verify` | Print the plan (default), make the changes, or print the pass or fail table. |
| `--step <name,name>` | Run only these steps: `providers`, `entra-apps`, `identities`, `azure-roles`, `admin-account`, `github`, `after-first-deploy`. |
| `--create-admin-account` | Create the admin account. Without it the script never creates a user. |
| `--admin-upn <upn>` | Name the account instead of being asked. |
| `--adopt-admin-account` | Use an existing user with that UPN. The script refuses by default. |
| `--after-first-deploy` | Add the step that needs the Static Web Apps and the portal account. |
| `--seed-self` | Write your own sign-in as the `admins` row. |
| `--alert-email <address>` | Set `ALERT_EMAIL`. Required the first time. |
| `--subject-form <auto\|name\|id>` | Choose the federated credential subject form. `auto` follows the repository. |
| `--repo <owner/name>` | Name the repository. The default is the current checkout. |

## What the script will not touch

It finds its two registrations by the tags `games4kids-bootstrap:games` and `games4kids-bootstrap:admin`. Before any Entra change it checks that every object the command names is one it owns, and it stops otherwise. drawpad's Draw Pad and letterjoin's Letter Tracing registrations cannot be changed through it. A registration that has one of the two names but not the tag is reported as a conflict and left alone.

## If a run stops

Run `--apply` again. Each step reads the current state first, so a run cut short at any point continues from what exists. If a step reports `BLOCKED`, the message names what to fix, and the other steps still run.
