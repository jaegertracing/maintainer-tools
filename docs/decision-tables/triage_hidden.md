# Decision table of `triage_hidden`

Generated from the rules by `pnpm run decision-tables`. Each column but the last three is a base fact. A dash marks a base fact that does not change whether `triage_hidden` holds in the row. The last two columns name the reasons and the vetoes for `triage_hidden` that hold in the row when every base fact with a dash is false. A row without a reason is a combination about which the rules say nothing.

| dco_missing | ci_failing | label_only_failure | merge_conflict | stale_on_author | over_quota | description_empty | no_approved_issue | no_issue_needed | author_can_write | author_is_dependency_bot | collaborators_not_gathered | is_duplicate | maintainer_spoke_last | unresolved_from_reviewer | `triage_hidden` | reasons that held | vetoes that held |
| --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- |
| yes | - | - | - | - | - | - | - | - | - | - | - | - | - | - | **yes** | dco_missing |  |
| no | - | - | yes | - | - | - | - | - | - | - | - | - | - | - | **yes** | merge_conflict |  |
| no | - | - | no | yes | - | - | - | - | - | - | - | - | - | - | **yes** | stale_on_author |  |
| no | - | - | no | no | yes | - | - | - | - | - | - | - | - | - | **yes** | over_quota<br>authors_turn |  |
| no | - | - | no | no | no | yes | - | - | - | - | - | - | - | - | **yes** | description_empty |  |
| no | - | - | no | no | no | no | - | - | - | - | - | yes | - | - | **yes** | is_duplicate<br>authors_turn |  |
| no | - | - | no | no | no | no | - | - | - | - | - | no | yes | - | **yes** | authors_turn |  |
| no | - | - | no | no | no | no | - | - | - | - | - | no | no | yes | **yes** | unresolved_from_reviewer |  |
| no | yes | yes | no | no | no | no | yes | yes | - | - | - | no | no | no | no |  |  |
| no | yes | yes | no | no | no | no | yes | no | yes | - | - | no | no | no | no |  |  |
| no | yes | yes | no | no | no | no | yes | no | no | yes | - | no | no | no | no |  |  |
| no | yes | yes | no | no | no | no | yes | no | no | no | yes | no | no | no | no |  |  |
| no | yes | yes | no | no | no | no | yes | no | no | no | no | no | no | no | **yes** | needs_issue<br>authors_turn |  |
| no | yes | yes | no | no | no | no | no | - | - | - | - | no | no | no | no |  |  |
| no | yes | no | no | no | no | no | - | - | - | - | - | no | no | no | **yes** | ci_failing_without_label_only_failure |  |
| no | no | - | no | no | no | no | yes | yes | - | - | - | no | no | no | no |  |  |
| no | no | - | no | no | no | no | yes | no | yes | - | - | no | no | no | no |  |  |
| no | no | - | no | no | no | no | yes | no | no | yes | - | no | no | no | no |  |  |
| no | no | - | no | no | no | no | yes | no | no | no | yes | no | no | no | no |  |  |
| no | no | - | no | no | no | no | yes | no | no | no | no | no | no | no | **yes** | needs_issue<br>authors_turn |  |
| no | no | - | no | no | no | no | no | - | - | - | - | no | no | no | no |  |  |

A derived fact that the last two columns name is decided by the rules below. The fact holds when one of its reasons, written `… ⇒ fact`, holds and none of its vetoes, written `… ⇒ not fact`, does.

- `ci_failing ⇒ ci_failing_without_label_only_failure`
- `label_only_failure ⇒ not ci_failing_without_label_only_failure`
- `no_approved_issue ⇒ needs_issue`
- `no_issue_needed ⇒ not needs_issue`
- `author_can_write ⇒ not needs_issue`
- `author_is_dependency_bot ⇒ not needs_issue`
- `collaborators_not_gathered ⇒ not needs_issue`
- `needs_issue ⇒ blocked`
- `is_duplicate ⇒ blocked`
- `over_quota ⇒ blocked`
- `maintainer_spoke_last ⇒ authors_turn`
- `blocked ⇒ authors_turn`
