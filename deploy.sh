#!/usr/bin/env bash
# Deliberately no automatic Git, database copy, installation or restart.
printf '%s\n' 'STOP: automatic deployment is disabled in this source package.' 'Read docs/SAFE-UPDATE.md and verify production storage, startup migrations and a fresh backup first.' 'This command has not modified code, data, Git or services.'
exit 1
