# adapters

The one directory where a real brain may be named (CONTRACT rule 8: "No
favorite brain"). A future issue adds the first real adapter here,
implementing the `Brain` interface from `../types.ts`. Nothing outside
this directory may reference a brain, model, or vendor name -
`contract/rule8.no-favorite-brain.test.ts` scans for that and skips only
this folder.
