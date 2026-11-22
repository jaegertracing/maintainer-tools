# Request for Comments (RFCs)

This directory contains the RFC documents of `maintainer-tools`. An RFC describes a problem, surveys the solutions and proposes one of them, so that the proposal can be discussed before it is built.

The RFCs follow the conventions of the main Jaeger repository, which its [RFC README](https://github.com/jaegertracing/jaeger/blob/main/docs/rfc/README.md) states in full. That document is the reference for the lifecycle of an RFC and for what may change in one after it merges.

## Conventions

- The file name is `NNNN-short-slug.md`, with the next number in sequence. The title is `# RFC NNNN: Title`.
- Files that accompany an RFC, such as test scripts and images, go in a directory `NNNN-short-slug/` next to it.
- A new RFC adds an entry to the index below.

## RFCs in This Repository

- [RFC 0001: Maintainer PR Triage and Nudge Tooling](./0001-maintainer-pr-triage-tooling.md): a shared library of PR predicates behind the triage report and the contributor nudges.
- [RFC 0002: Sharper triage signal](./0002-triage-signal.md): diff composition, referenced issues and ordering in the triage report.
- [RFC 0003: Automating the Lifecycle of Issues and Pull Requests in Jaeger](./0003-issue-and-pr-lifecycle-automation.md): one reconciler that derives the labels, the comment and the closing of a pull request from declarative rules.
