# Decision table of `label:pr-quota-reached`

Generated from the rules by `pnpm run decision-tables`. Each column but the last three is a base fact. A dash marks a base fact that does not change whether `label:pr-quota-reached` holds in the row. The last two columns name the reasons and the vetoes for `label:pr-quota-reached` that hold in the row when every base fact with a dash is false. A row without a reason is a combination about which the rules say nothing.

| over_quota | `label:pr-quota-reached` | reasons that held | vetoes that held |
| --- | --- | --- | --- |
| yes | **yes** | over_quota |  |
| no | no |  |  |
