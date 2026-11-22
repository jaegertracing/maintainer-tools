# Decision table of `triage_hidden`

Generated from the rules by `pnpm run decision-tables`. Each column but the last three is a base fact. A dash marks a base fact that does not change whether `triage_hidden` holds in the row. The last two columns name the reasons and the vetoes for `triage_hidden` that hold in the row when every base fact with a dash is false. A row without a reason is a combination about which the rules say nothing.

| dco_missing | ci_failing | label_only_failure | merge_conflict | stale_on_author | quota_exceeded | description_empty | no_linked_issue | missing_issue_label | unresolved_from_reviewer | `triage_hidden` | reasons that held | vetoes that held |
| --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- |
| yes | - | - | - | - | - | - | - | - | - | **yes** | dco_missing |  |
| no | - | - | yes | - | - | - | - | - | - | **yes** | merge_conflict |  |
| no | - | - | no | yes | - | - | - | - | - | **yes** | stale_on_author |  |
| no | - | - | no | no | yes | - | - | - | - | **yes** | quota_exceeded |  |
| no | - | - | no | no | no | yes | - | - | - | **yes** | description_empty |  |
| no | - | - | no | no | no | no | - | - | yes | **yes** | unresolved_from_reviewer |  |
| no | yes | yes | no | no | no | no | yes | yes | no | **yes** | no_linked_issue ∧ missing_issue_label |  |
| no | yes | yes | no | no | no | no | yes | no | no | no |  |  |
| no | yes | yes | no | no | no | no | no | - | no | no |  |  |
| no | yes | no | no | no | no | no | - | - | no | **yes** | ci_failing_without_label_only_failure |  |
| no | no | - | no | no | no | no | yes | yes | no | **yes** | no_linked_issue ∧ missing_issue_label |  |
| no | no | - | no | no | no | no | yes | no | no | no |  |  |
| no | no | - | no | no | no | no | no | - | no | no |  |  |

A derived fact that the last two columns name is decided by the rules below. The fact holds when one of its reasons, written `… ⇒ fact`, holds and none of its vetoes, written `… ⇒ not fact`, does.

- `ci_failing ⇒ ci_failing_without_label_only_failure`
- `label_only_failure ⇒ not ci_failing_without_label_only_failure`
