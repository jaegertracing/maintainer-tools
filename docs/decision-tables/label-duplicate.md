# Decision table of `label:duplicate`

Generated from the rules by `pnpm run decision-tables`. Each column but the last three is a base fact. A dash marks a base fact that does not change whether `label:duplicate` holds in the row. The last two columns name the reasons and the vetoes for `label:duplicate` that hold in the row when every base fact with a dash is false. A row without a reason is a combination about which the rules say nothing.

| is_duplicate | `label:duplicate` | reasons that held | vetoes that held |
| --- | --- | --- | --- |
| yes | **yes** | is_duplicate |  |
| no | no |  |  |
