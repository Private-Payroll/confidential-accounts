# Changelog

The format is [Keep a Changelog](https://keepachangelog.com/en/1.1.0/), and this project intends to
follow [Semantic Versioning](https://semver.org/spec/v2.0.0.html) from its first release.

**THERE HAS NOT BEEN A RELEASE YET, AND THIS FILE STARTS HERE RATHER THAN BEING BACKFILLED.**
`package.json` carries `1.0.0` and `"private": true`: nothing is published to a registry, no tag has
been cut, and that version number has never meant anything to anybody outside this repository. Writing
a history of releases that did not happen would make this file the least trustworthy document in the
project on its first day.

**What happened before this file is in the pull requests on `main`**, each one a single change with
its reasoning in the body. That is a real record and it is the one to read; this file starts
recording the moment there is a version for an entry to belong to.

## [Unreleased]

### Added

- `CONTRIBUTING.md`, `SECURITY.md`, `CODE_OF_CONDUCT.md`, this file, `.editorconfig`, a pull request
  template and issue templates — the files a reader looks for before they read any code, none of
  which existed.

---

## How an entry is written here

**One line per change, in the words of somebody affected by it.** Not the commit subject, which
describes the edit; the entry describes what is different for a person using this.

Under `Added`, `Changed`, `Deprecated`, `Removed`, `Fixed` or `Security`, as Keep a Changelog defines
them. **Anything that changes what is disclosed, what a screen promises, or how money moves goes
under `Security` as well as wherever else it belongs** — a reader deciding whether to upgrade urgently
should not have to infer it from a line under `Fixed`.

An entry names the pull request. It does not name a person: a change is described by what it does,
which is the same rule the commit checker holds a message to.
