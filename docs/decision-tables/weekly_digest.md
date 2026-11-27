# Decision table of `weekly_digest`

Generated from the rules by `pnpm run decision-tables`. Each column but the last three is a base fact. A dash marks a base fact that does not change whether `weekly_digest` holds in the row. The last two columns name the reasons and the vetoes for `weekly_digest` that hold in the row when every base fact with a dash is false. A row without a reason is a combination about which the rules say nothing.

| dco_missing | ci_failing | label_only_failure | merge_conflict | description_empty | no_linked_issue | missing_issue_label | no_tests_for_code_change | unresolved_from_reviewer | `weekly_digest` | reasons that held | vetoes that held |
| --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- |
| yes | - | - | - | - | - | - | - | - | **yes** | dco_missing |  |
| no | - | - | yes | - | - | - | - | - | **yes** | merge_conflict |  |
| no | - | - | no | yes | - | - | - | - | **yes** | description_empty |  |
| no | - | - | no | no | - | - | yes | - | **yes** | no_tests_for_code_change |  |
| no | - | - | no | no | - | - | no | yes | **yes** | unresolved_from_reviewer |  |
| no | yes | yes | no | no | yes | yes | no | no | no |  |  |
| no | yes | yes | no | no | yes | no | no | no | **yes** | no_linked_issue_without_missing_issue_label |  |
| no | yes | yes | no | no | no | - | no | no | no |  |  |
| no | yes | no | no | no | - | - | no | no | **yes** | ci_failing_without_label_only_failure |  |
| no | no | - | no | no | yes | yes | no | no | no |  |  |
| no | no | - | no | no | yes | no | no | no | **yes** | no_linked_issue_without_missing_issue_label |  |
| no | no | - | no | no | no | - | no | no | no |  |  |

A derived fact that the last two columns name is decided by the rules below. The fact holds when one of its reasons, written `… ⇒ fact`, holds and none of its vetoes, written `… ⇒ not fact`, does.

- `ci_failing ⇒ ci_failing_without_label_only_failure`
- `label_only_failure ⇒ not ci_failing_without_label_only_failure`
- `no_linked_issue ⇒ no_linked_issue_without_missing_issue_label`
- `missing_issue_label ⇒ not no_linked_issue_without_missing_issue_label`
