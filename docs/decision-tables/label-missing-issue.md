# Decision table of `label:missing-issue`

Generated from the rules by `pnpm run decision-tables`. Each column but the last three is a base fact. A dash marks a base fact that does not change whether `label:missing-issue` holds in the row. The last two columns name the reasons and the vetoes for `label:missing-issue` that hold in the row when every base fact with a dash is false. A row without a reason is a combination about which the rules say nothing.

| no_approved_issue | no_issue_needed | author_can_write | author_is_dependency_bot | collaborators_not_gathered | links_open_issue | `label:missing-issue` | reasons that held | vetoes that held |
| --- | --- | --- | --- | --- | --- | --- | --- | --- |
| yes | yes | - | - | - | - | no |  |  |
| yes | no | yes | - | - | - | no |  |  |
| yes | no | no | yes | - | - | no |  |  |
| yes | no | no | no | yes | - | no |  |  |
| yes | no | no | no | no | yes | no | needs_issue | links_open_issue |
| yes | no | no | no | no | no | **yes** | needs_issue |  |
| no | - | - | - | - | - | no |  |  |

A derived fact that the last two columns name is decided by the rules below. The fact holds when one of its reasons, written `… ⇒ fact`, holds and none of its vetoes, written `… ⇒ not fact`, does.

- `no_approved_issue ⇒ needs_issue`
- `no_issue_needed ⇒ not needs_issue`
- `author_can_write ⇒ not needs_issue`
- `author_is_dependency_bot ⇒ not needs_issue`
- `collaborators_not_gathered ⇒ not needs_issue`
