# Decision table of `label:stale`

Generated from the rules by `pnpm run decision-tables`. Each column but the last three is a base fact. A dash marks a base fact that does not change whether `label:stale` holds in the row. The last two columns name the reasons and the vetoes for `label:stale` that hold in the row when every base fact with a dash is false. A row without a reason is a combination about which the rules say nothing.

| quiet | do_not_expire | `label:stale` | reasons that held | vetoes that held |
| --- | --- | --- | --- | --- |
| yes | yes | no |  |  |
| yes | no | **yes** | idle |  |
| no | - | no |  |  |

A derived fact that the last two columns name is decided by the rules below. The fact holds when one of its reasons, written `… ⇒ fact`, holds and none of its vetoes, written `… ⇒ not fact`, does.

- `quiet ⇒ idle`
- `do_not_expire ⇒ not idle`
