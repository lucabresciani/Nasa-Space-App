# Backend contract examples

Illustrative documents, one or more per schema, named `{schema}.{case}.json`
(`plan_inputs.official.json` validates against `../plan_inputs.schema.json`). They are not engine
output: hashes are placeholders and numbers are made up. `tests/test_backend_contracts.py` validates
every file here and the OpenAPI document points at them (`externalValue`) for `/api/docs` and WS13 mocks.
