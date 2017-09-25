#
# Copyright (c) 2017, Joyent, Inc. All rights reserved.
#
# Makefile: top-level Makefile
#
# This Makefile contains only repo-specific logic and uses included makefiles
# to supply common targets (javascriptlint, jsstyle, restdown, etc.), which are
# used by other repos as well.
#

#
# Tools
#
NPM		 = npm

#
# Files
#
JSON_FILES	 = package.json
JS_FILES	:= bin/promstat $(shell find lib -name '*.js')
JSL_FILES_NODE	 = $(JS_FILES)
JSSTYLE_FILES	 = $(JS_FILES)
JSL_CONF_NODE	 = tools/jsl.node.conf

include ./tools/mk/Makefile.defs
include ./tools/mk/Makefile.node_modules.defs

.PHONY: all
all: $(STAMP_NODE_MODULES)

include ./tools/mk/Makefile.node_modules.targ
include ./tools/mk/Makefile.targ
