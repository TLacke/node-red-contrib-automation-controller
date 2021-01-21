module.exports = function(RED) {
    "use strict";
    var vm = require("vm");

    function getTime(v, t) {
        if (t === "ms") return v;
        else if (t === "m") return v * (60 * 1000);
        else if (t === "h")   return v * (60 * 60 * 1000);
        else if (t === "d")    return v * (24 * 60 * 60 * 1000);
        else return v * 1000;
    }

    function getRule(node, rule) {
        if (Number.isInteger(rule))
            return node.rules[rule];
        return node.rules.find(r=>rule==r.r.name);
    }

    // Creates a new script object
    function createScript(node, type, code) {
        var opt = {
            filename: 'Function automationController.'+type+':'+node.id+(node.name?' ['+node.name+']':''), // filename for stack traces
            displayErrors: true
        };
        var sc = "(function(msg) {"+code +"})(msg)";
        return vm.createScript(sc, opt);
    }

    // Initiates the script object.
    function runScript(node, ri, s, type, fName, msg, inp) {
        // Setup the script object functionality for the node.
        if (!node.script) {
            node.script = {
                sandbox: {
                    console:console,
                    Buffer:Buffer,
                    Date: Date,
                    __node__: {
                        id: node.id,
                        name: node.name
                    },
                    context: {
                        set: function() {
                            node.context().set.apply(node,arguments);
                        },
                        get: function() {
                            return node.context().get.apply(node,arguments);
                        },
                        keys: function() {
                            return node.context().keys.apply(node,arguments);
                        },
                        get global() {
                            return node.context().global;
                        },
                        get flow() {
                            return node.context().flow;
                        }
                    },
                    flow: {
                        set: function() {
                            node.context().flow.set.apply(node,arguments);
                        },
                        get: function() {
                            return node.context().flow.get.apply(node,arguments);
                        },
                        keys: function() {
                            return node.context().flow.keys.apply(node,arguments);
                        }
                    },
                    global: {
                        set: function() {
                            node.context().global.set.apply(node,arguments);
                        },
                        get: function() {
                            return node.context().global.get.apply(node,arguments);
                        },
                        keys: function() {
                            return node.context().global.keys.apply(node,arguments);
                        }
                    },
                    env: {
                        get: function(envVar) {
                            var flow = node._flow;
                            return flow.getSetting(envVar);
                        }
                    },
                    rules: {
                        index: function(rule) {
                            var r = getRule(node, rule); 
                            return !!r?r.i:"Invalid rule: " + rule;
                        },
                        name: function(rule) {
                            var r = getRule(node, rule); 
                            return !!r?r.r.name:"Invalid rule: " + rule;
                        },
                        value: function(rule) {
                            var r = getRule(node, rule); 
                            return !!r?r.vLast:"Invalid rule: " + rule;
                        },
                        isActive: function(rule) {
                            var r = getRule(node, rule); 
                            return !!r?r.a:"Invalid rule: " + rule;
                        },
                        length: function() {
                            return node.rules.length;
                        }
                    }
                }
            };
        }
        
        if (!ri.script) {
            ri.script = {
                ctx: vm.createContext(node.script.sandbox),
                s:{},
                run: function(name, msg, inp) {
                    this.ctx.msg = msg;
                    this.ctx.lastValue = node.lastRule.vLast;
                    this.ctx.lastRuleValue = ri.vLast;
                    this.ctx.lastRuleName = node.lastRule.r.name;
                    if (inp !== undefined) this.ctx.input = inp;
                    return this.s[name].runInContext(this.ctx);
                }
            };
        }

        if (!ri.script.s[fName]) {
            ri.script.s[fName] = createScript(node, type, s[fName]);
        }
        
        try {
        return ri.script.run(fName, msg, inp);
        } catch (e) {
            console.log("Error when executing script: " + fName, e);
        }
    }

    function AutomationControllerNode(config) {
        RED.nodes.createNode(this,config);
        var node = this;

        var T_INACTIVE = 0;
        var T_ACTIVE = 1;
        var T_REPEAT = 2;
        var T_TIMEOUT = 3;

        var so = config.seperated;  // Seperated outputs
        var lm;                     // Latest message
        var act = [];
        var r = [];     // Rules
        var ri;         // Rule item
        var ru;         // Rule config
        
        this.lastRule = undefined;
        
        function flagActive(r) {
            if (r.a) {
                if (act.indexOf(r)==-1)
                    act.push(r);
                
            } else {
                for (var i=act.length-1;i>=0;i--) {
                    if (act[i]==r) {
                        act.splice(i,1);
                        break;
                    }
                }
            }
        }

        function checkDone() {
            if (act.length==0) {
                node.done();
            }
        }

        function chkNum(v, id, err, r) {
            if (!Number.isInteger(v)) {
                node.error(RED._("error."+id, {error:err + r.name}));
                return false;
            }
            return true;
        }

        function updateMsg(rule, msg, c) {
            if (rule.ist) {
                switch (rule.r.repMsgType) {
                case 'pay':
                    if (rule.a && c) rule.msg = msg;
                    break;
                    
                case 'payl':
                    rule.msg = lm;
                    break;
    
                case 'payr':
                    rule.msg = msg;
                    break;
                }
            } else {
                // If event, then set message
                rule.msg = msg;
    
            }
            return rule.msg;
        }
        
        function updateStatus(r,custom) {
            node.status({fill:r.a?'green':'red',shape:"dot",text:r.r.name + ': ' + RED._("status."+custom)});
        }

        // Rule, ScriptStorage, Type, ValueType, Value, JSFieldName, message, isInt
        function evalCmd(r, s, type, vt, v, js, msg, fInt, inp) {
            switch (vt) {
             case 'js':
                r = runScript(node, r, s, type, js, msg, inp);
                break;

             default:
                r = RED.util.evaluateNodeProperty(v, vt, node, msg);
                break;
            }
            
            if (fInt===true)
                r = Number.parseInt(r, 10);
            
            return r;
        }

        // Input, Rule, ScriptStorage, Type, ValueType, Value, JSFieldName, message, isInt
        function matchCmd(inp, r, s, type, vt, v, js, msg, fInt) {
            v = evalCmd(r,s,type,vt,v,js,msg,fInt,inp);
            
            // If javascript, then accept true/false
            if (vt=='js' && (v==true || v==false))
                return v;
            
            return inp==v;
        }
        
        // Setup rules
        for (var i=0; i<config.rules.length; i++) {
            ru = config.rules[i];

            ri = {
                i:i,                                // Index
                r:ru,                               // Rule
                isState:ru.matchMode=='state',      // isState
                a:false,                            // Active
                ma:ru.triggerActive,                // Multiple activations
                msg:undefined,                      // Usage message
                rt:getTime(ru.rep, ru.repType),     // Repeat
                hr:undefined,                       // Repeat handler
                to:getTime(ru.to, ru.toType),       // Timeout
                co:getTime(ru.cool, ru.coolType),   // Cooldown
                rs:getTime(ru.resEvent, ru.resEventType), // reset event
                ht:undefined,                       // Timeout handler
                vLast:undefined,
                t:function(inp,msg,send,res) {      // Test
                    var v,t;
                    
                    var act = matchCmd(inp, this.r, this.r, "active", this.r.activeType, this.r.active, "activeJS", msg, false);
                    
                    if (act) {
                        updateMsg(this, msg, false);
                    }

                    // If not active or multi activations
                    if (act && (!this.a || this.ma)) {
                        return this.e(msg, T_ACTIVE, send, res);
                    }
                    
                    if (this.a && this.isState) {
                        if (matchCmd(inp, this.r, this.r, "inactive", this.r.inactiveType, this.r.inactive, "inactiveJS", msg, false)) {
                            return this.e(msg, T_INACTIVE, send, res);
                        }
                    }
                },
                e:function(msg,event,send,res) {        // Execute
                    var state = (event==T_ACTIVE || event==T_REPEAT);  // New state

                    // If activating/active, then
                    if (state) {
                        // Check behavior
                        switch (config.behavior) {
                        case 'sng':     // Accept single
                            // If has active and not only this, then abort
                            if (act.length > 0 && (act.length!=1 || act[0]!=this)) {
                                return;
                            }
                            break;

                        case 'mul':     // Accept multiple
                            break;

                        case 'can':     // Cancel others
                            // Loop though active and cancel all
                            if (state)
                                act.forEach(r=>{
                                    if (r!=this) r.c(send);
                                });
                            break;
                        }
                    }
                    var c = this.a != state;               // Changed
                    this.a = state;                        // Set state

                    // If inactive and not changed, then abort
                    if (!this.a && !c) {
                        return;
                    }

                    // Update message
                    msg = updateMsg(this, msg, c);
                    
                    // If state
                    if (this.isState) {
                        // If state changed, then
                        if (c) {
                            // If active, then add timers
                            if (this.a) {
                                this.hr = setInterval(()=>{
                                    if (this.a) this.e(this.msg, T_REPEAT, send);
                                }, this.rt);

                                this.ht = setTimeout(()=>{
                                    if (this.a) this.e(this.msg, T_TIMEOUT, send);
                                }, this.to);

                            } else {
                                clearInterval(this.hr);
                                clearTimeout(this.ht);
                                this.ht=this.hr=undefined;
                            }
                        } else {
                            // If not changed but active, then restart timers
                            if (event==T_ACTIVE && this.ma) {
                                clearInterval(this.hr);
                                clearTimeout(this.ht);
                                this.hr = setInterval(()=>{
                                    if (this.a) this.e(this.msg, T_REPEAT, send);
                                }, this.rt);
                                this.ht = setTimeout(()=>{
                                    if (this.a) this.e(this.msg, T_TIMEOUT, send);
                                }, this.to);
                            }
                        }

                    // Else if event
                    } else {
                        if (this.a) {
                            // If already active, then abort
                            if (!c) {
                                return;
                            }

                            clearInterval(this.hr);
                            this.hr = undefined;

                            // If has time out, then
                            if (this.co > 0) {
                                this.ht = setTimeout(()=>{
                                    if (this.a) {
                                        this.e(this.msg, T_TIMEOUT, send);
                                    }
                                }, this.co);
                            }

                            // If has reset event, then
                            if (this.rs > 0) {
                                this.hr = setTimeout(()=>{
                                    this.v.c = undefined;
                                    updateStatus(this, "reset");
                                }, this.rs);
                            }
                        }
                    }
                    
                    flagActive(this);
                    
                    var v;
                    
                    if (this.a) {
                        var rv = event==T_ACTIVE && this.isState && this.r.resetInitial;
                        if (!rv && msg!==undefined && msg.state=='reset') rv = true;

                        // Check if is custom engine value
                        var al = !rv;
                        if (msg!==undefined && !isNaN(Number.parseInt(msg.engineValue))) {
                            this.v.c = Number.parseInt(msg.engineValue);
                            al = false;
                        }

                        v = this.v.e(rv, al);
                        this.vLast = v;
                        node.lastRule = this;

                        delete msg.state;
                        delete msg.engineValue;
                        
                    } else if (this.isState) {
                        switch (this.r.onInactiveType) {
                            case 'nul':
                                v = undefined;
                                break;
                            default:
                                v = evalCmd(this.r, this.r, "onInactive", this.r.onInactiveType, this.r.onInactive, "onInactiveJS", this.msg, false);
                                this.vLast = v;
                                node.lastRule = this;
                        }
                    }

                    if (!this.isState && this.a && this.co == 0) {
                        this.a = false;
                        this.msg = undefined;
                    }
                    
                    if (msg !== undefined && v !== undefined) {
                        var m = Object.assign({},msg);
                        m[this.r.output] = v;
                        
                        if (so) {
                            // If no result object, then create one and send, otherwise add to it
                            if (res==undefined) {
                                res = [];
                                res[this.i] = m;
                                send(res);
                            } else {
                                res[this.i] = m;
                            }
                        } else {
                            send(m);
                        }
                    }

                    // Show status icon.
                    updateStatus(this, this.a?"active":"inactive");
                    
                    // If is a time out/cooldown, then check if all done
                    if (event==T_TIMEOUT)
                        checkDone();
                    
                },
                c:function(send) {  // Cancel
                    // If not active, then skip cancel
                    if (!this.a)
                        return;
                    
                    // Execute timeout
                    this.e(this.msg, T_TIMEOUT, send);
                    
                    clearTimeout(this.ht);
                },
                init:function() {
                    var rule = this;
                    switch (this.r.mode) {
                        case 'single':
                            this.v = {
                                r:rule,            // Rule
                                e:function(rv) {
                                    return evalCmd(this.r, this.r.r, "value", this.r.r.sValueType, this.r.r.sValue, "sValueJS", this.r.msg, false);
                                }
                            };
                            break;
                        case 'iterate':
                            this.v = {
                                r:rule,         // Rule
                                i:function() {  // Initial value
                                    return evalCmd(this.r, this.r.r, "init", this.r.r.iInitType, this.r.r.iInit, "iInitJS", this.r.msg, true);
                                },
                                c:undefined,    // Current
                                mi:undefined,   // Min
                                ma:undefined,   // Max
                                s: undefined,   // Steps
                                e:function(rv,al,neg) {
                                    // If no current or to reset value, then
                                    var r = this.c==undefined || rv;

                                    // If to reset, then
                                    if (r) {
                                        this.c = this.i();
                                        
                                        // Validate number
                                        if (!chkNum(this.c, "invalidInit", "Invalid iterate value for rule ", this.r))
                                            return;

                                    // If no reset, then iterate to next value
                                    } else {
                                        this.mi = Number.parseInt(RED.util.evaluateNodeProperty(this.r.r.iMin, this.r.r.iMinType, node, this.r.msg), 10);
                                        this.ma = Number.parseInt(RED.util.evaluateNodeProperty(this.r.r.iMax, this.r.r.iMaxType, node, this.r.msg), 10);
                                        this.s = Number.parseInt(RED.util.evaluateNodeProperty(this.r.r.iSteps, this.r.r.iStepsType, node, this.r.msg), 10);

                                        // Validate number
                                        if (!chkNum(this.s, "stepVal", "Invalid step value for rule ", this.r))
                                            return;
                                        
                                        // Validate number
                                        if (!chkNum(this.mi, "minVal", "Invalid min value for rule ", this.r))
                                            return;
                                        
                                        // Validate number
                                        if (!chkNum(this.ma, "maxVal", "Invalid max value for rule ", this.r))
                                            return;
                                        
                                        var p;
                                        if (al) {
                                            p=this.c;
                                            if (neg!==true)
                                                this.c+=this.s;
                                            else
                                                this.c-=this.s;
                                        }

                                        // -1 < min, 1 > max
                                        var ch=this.c<this.mi?-1:this.c>this.ma?1:0;

                                        if (ch!=0) {
                                            // If move to edge, then
                                            if (this.r.r.iEdge) {
                                                if (ch==1 && p < this.ma) {
                                                    this.c = this.ma;
                                                } else if (ch==-1 && p > this.mi) {
                                                    this.c = this.mi;
                                                } else {
                                                    // If to cycle the value, then
                                                    if (this.r.r.iCycle) {
                                                        this.c = ch==1?this.mi:this.ma; // If is max then, min otherwise max
                                                    } else {
                                                        // Otherwise, complete
                                                        return undefined;
                                                    }
                                                }
                                            } else {
                                                // If to cycle the value, then
                                                if (this.r.r.iCycle) {
                                                    var ml = 10;    // Test times
                                                    var size = this.ma-this.mi;
                                                    if (ch==1) {
                                                        while (this.c>this.ma && ml>0) {
                                                            this.c-= size;
                                                            ml--;
                                                        }
                                                    } else {
                                                        while (this.c<this.mi && ml>0) {
                                                            this.c+= size;
                                                            ml--;
                                                        }
                                                    }
                                                } else {
                                                    // Otherwise, complete
                                                    //this.c=this.ma;
                                                    return undefined;
                                                }
                                            }
                                        }
                                    }

                                    return this.c;
                                }
                            };
                            break;
                        case 'bounce':
                            this.v = {
                                r:rule,         // Rule
                                i:function() {  // Initial value
                                    return evalCmd(this.r, this.r.r, "init", this.r.r.bInitType, this.r.r.bInit, "bInitJS", this.r.msg, true);
                                },
                                c:undefined,    // Current
                                p:rule.r.bIPos, // Positive mode
                                mi:undefined,   // Min
                                ma:undefined,   // Max
                                s: undefined,   // Steps
                                e:function(rv,al,neg) {
                                    var po = neg!==true;

                                    // If no current or to reset value, then
                                    var r = this.c==undefined || rv;

                                    // If to reset, then
                                    if (r) {
                                        this.c = this.i();
                                        this.p = this.r.r.bIPos;

                                        // Validate number
                                        if (!chkNum(this.c, "invalidInit", "Invalid iterate value for rule ", this.r))
                                            return;
                                        
                                    // If no reset, then iterate to next value
                                    } else {
                                        this.mi = Number.parseInt(RED.util.evaluateNodeProperty(this.r.r.bMin, this.r.r.bMinType, node, this.r.msg), 10);
                                        this.ma = Number.parseInt(RED.util.evaluateNodeProperty(this.r.r.bMax, this.r.r.bMaxType, node, this.r.msg), 10);
                                        if (this.p==po) {
                                            this.s = Number.parseInt(RED.util.evaluateNodeProperty(this.r.r.bUp, this.r.r.bUpType, node, this.r.msg), 10);
                                        } else {
                                            this.s = Number.parseInt(RED.util.evaluateNodeProperty(this.r.r.bDown, this.r.r.bDownType, node, this.r.msg), 10);
                                        }

                                        // Validate number
                                        if (!chkNum(this.s, "stepVal", "Invalid step value for rule ", this.r))
                                            return;
                                        
                                        // Validate number
                                        if (!chkNum(this.mi, "minVal", "Invalid min value for rule ", this.r))
                                            return;
                                        
                                        // Validate number
                                        if (!chkNum(this.ma, "maxVal", "Invalid max value for rule ", this.r))
                                            return;
                                        
                                        // If positive, then convert value to negative after validation.
                                        if (this.p!=po && this.s > 0)
                                            this.s=-this.s;

                                        if (al) {
                                            this.c+=this.s;
                                        }

                                        if (this.c<this.mi || this.c>this.ma) {
                                            this.c-=this.s;
                                            this.p = !this.p;

                                            // If move to edge, then
                                            if (this.r.r.bEdge) {
                                                if (this.p!=po && this.c < this.ma) {
                                                    this.c = this.ma;
                                                } else if (this.p==po && this.c > this.mi) {
                                                    this.c = this.mi;
                                                } else {
                                                    return this.e(false, true, neg);
                                                }
                                            } else {
                                                return this.e(false, true, neg);
                                            }
                                        }
                                    }

                                    return this.c;
                                }
                            };
                            break;
                        case 'fixed':
                            this.v = {
                                r:rule,         // Rule
                                i:function() {  // Initial value
                                    return evalCmd(this.r, this.r.r, "init", this.r.r.fInitType, this.r.r.fInit, "fInitJS", this.r.msg, true);
                                },
                                c:undefined,    // Current value
                                v:rule.r.fValues,  // values array
                                e:function(rv, al,neg) { // Reset value, 
                                    // If no current or to reset value, then
                                    var r = this.c==undefined || rv;
                                    if (r) {
                                        this.c = this.i();
                                    }
                                    
                                    // Validate number
                                    if (!Number.isInteger(this.c)) {
                                        node.error(RED._("error.invalidIdx", {error:'Invalid fixed index for rule ' + this.r.name}));
                                        return;
                                    }
                                    
                                    // If no reset, then iterate to next value
                                    if (!r && al) {
                                        if (neg!==true) {
                                            if (this.c<this.v.length)
                                                this.c++;
                                        } else {
                                            if (this.c>=0)
                                                this.c--;
                                        }
                                    }

                                    // Validate value
                                    if (this.c < 0) {
                                        // If not negative, then just set to zero
                                        if (neg!==true) {
                                            this.c = 0;
                                        } else {
                                            if (this.r.r.fCycle) {
                                                this.c = this.v.length - 1;
                                            } else {
                                                return undefined;
                                            }
                                        }
                                    }
                                    if (this.c>=this.v.length) {
                                        // If to cycle, then
                                        if (this.r.r.fCycle) {
                                            this.c = 0;
                                        } else {
                                            // Otherwise complete
                                            return undefined;
                                        }
                                    }

                                    var v = this.v[this.c];
                                    return evalCmd(v, v, "value", v.t, v.v, "js", this.r.msg, false);
                                }
                            };
                            break;
                        case 'linked':
                            this.v = {
                                r:rule,                              // Rule
                                l:r.find(ri=>ri.r.id==rule.r.lLink), // Linked rule
                                e:function(rv,al) {
                                    var r = this.l.v.e(rv,al,this.r.r.lNeg);
                                    if (this.r.r.lUpRule) {
                                        this.l.vLast = r;
                                    }
                                    return r;
                                }
                            };
                            break;
                    }
                }
            };

            // If JSON repeat message, then static parse
            if (ri.r.repMsgType == 'json') {
                ri.msg = JSON.parse(ri.r.repMsg);
            }

            r.push(ri);
            
            if (!this.lastRule)
                this.lastRule = ri;
        }

        // Initiate all rules.
        for (var i=0; i<r.length; i++) {
            r[i].init();
        }

        this.rules = r;
        
        this.on("input", function(msg, send, done) {
            node.done = done;

            lm = msg;
            var inp = RED.util.evaluateNodeProperty(config.inputValue, config.inputType, node, msg);
            
            if (so) { // Seperate output
                var res = [];
                r.forEach(e=> e.t(inp,msg,send,res) );

                // Check if has any values to send.
                if (res.findIndex(re=>re!=undefined) != -1)
                    send(res);
                
            } else {
                r.forEach(e=> e.t(inp,msg,send,res) );
            }
            
            checkDone();
        });

        this.on("close", function() {
            r.forEach(e=> {
                if (e.hr!=undefined) clearInterval(e.hr);
                if (e.ht!=undefined) clearTimeout(e.ht);
            });
        });
    }
    RED.nodes.registerType("automation controller",AutomationControllerNode);
}
