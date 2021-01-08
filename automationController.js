module.exports = function(RED) {
    "use strict";

    function getTime(v, t) {
        if (t === "ms") return v;
        else if (t === "m") return v * (60 * 1000);
        else if (t === "h")   return v * (60 * 60 * 1000);
        else if (t === "d")    return v * (24 * 60 * 60 * 1000);
        else return v * 1000;
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
        var r = [];
        var ri,ru;

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
        
        function updateStatus(r) {
            node.status({fill:r.a?'green':'red',shape:"dot",text:r.r.name + ': ' + (r.a?"active":"inactive")});
        }
        
        // Setup rules
        for (var i=0; i<config.rules.length; i++) {
            ru = config.rules[i];

            ri = {
                i:i,                                // Index
                r:ru,                               // Rule
                ist:ru.matchMode=='state',          // isState
                a:false,                            // Active
                ma:ru.triggerActive,                // Multiple activations
                msg:undefined,                      // Usage message
                rt:getTime(ru.rep, ru.repType),     // Repeat
                hr:undefined,                       // Repeat handler
                to:getTime(ru.to, ru.toType),       // Timeout
                co:getTime(ru.cool, ru.coolType),   // Cooldown
                rs:getTime(ru.resEvent, ru.resEventType), // reset event
                ht:undefined,                       // Timeout handler
                t:function(inp,msg,send,res) {      // Test
                    var v,t;
                    
                    var a = (inp == RED.util.evaluateNodeProperty(this.r.active,this.r.activeType,node,msg));
                    
                    if (a) {
                        updateMsg(this, msg, false);
                    }

                    // If not active or multi activations
                    if (a && (!this.a || this.ma)) {
                        return this.e(msg, T_ACTIVE, send, res);
                    }
                    
                    if (this.a && this.ist) {
                        if (inp == RED.util.evaluateNodeProperty(this.r.inactive,this.r.inactiveType,node,msg)) {
                            return this.e(msg, T_INACTIVE, send, res);
                        }
                    }
                },
                e:function(msg,a,send,res) {        // Execute
                    var st = (a==T_ACTIVE || a==T_REPEAT);  // New state

                    // If activating/active, then
                    if (st) {
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
                            if (st)
                                act.forEach(r=>{
                                    if (r!=this) r.c(send);
                                });
                            break;
                        }
                    }
                    var c = this.a != st;                   // Changed
                    this.a = st;                            // Set state

                    // If inactive and not changed, then abort
                    if (!this.a && !c) {
                        return;
                    }

                    // Update message
                    msg = updateMsg(this, msg, c);
                    
                    // If state
                    if (this.ist) {
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
                            if (a==T_ACTIVE && this.ma) {
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
                                    this.v.e(true, false);
                                }, this.rs);
                            }
                        }
                    }
                    
                    flagActive(this);
                    
                    var v;
                    
                    if (this.a) {
                        var rv = a==T_ACTIVE && this.ist && this.r.resetInitial;
                        if (!rv && msg!==undefined && msg.state=='reset') rv = true;

                        // Check if is custom engine value
                        var al = true;
                        if (msg!==undefined && !isNaN(parseInt(msg.engineValue))) {
                            this.v.c = Number.parseInt(msg.engineValue);
                            al = false;
                        }

                        v = this.v.e(rv, al);

                        delete msg.state;
                        delete msg.engineValue;
                        
                    } else if (this.ist) {
                        switch (this.r.onInactiveType) {
                            case 'nul':
                                v = undefined;
                                break;
                            default:
                                v = RED.util.evaluateNodeProperty(this.r.onInactive, this.r.onInactiveType, node, this.msg);
                        }
                    }

                    if (!this.ist && this.a && this.co == 0) {
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
                    updateStatus(this);
                    
                    // If is a time out/cooldown, then check if all done
                    if (a==T_TIMEOUT)
                        checkDone();
                    
                },
                c:function(send) {
                    // If not active, then skip cancel
                    if (!this.a)
                        return;
                    
                    // Execute timeout
                    this.e(this.msg, T_TIMEOUT, send);
                    
                    clearTimeout(this.ht);
                },
                init:function() {
                    var r = this;
                    switch (this.r.mode) {
                        case 'single':
                            this.v = {
                                r:r,            // Rule
                                e:function(rv) {
                                    return RED.util.evaluateNodeProperty(this.r.r.sValue, this.r.r.sValueType, node, this.r.msg);
                                }
                            };
                            break;
                        case 'iterate':
                            this.v = {
                                r:r,            // Rule
                                i:function() {  // Initial value
                                    return Number.parseInt(RED.util.evaluateNodeProperty(this.r.r.iInit, this.r.r.iInitType, node, this.r.msg), 10);
                                },
                                c:undefined,    // Current
                                mi:undefined,   // Min
                                ma:undefined,   // Max
                                s: undefined,   // Steps
                                e:function(rv, al) {
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
                                        
                                        if (al) {
                                            this.c+=this.s;
                                        }

                                        if (this.c>this.ma) {
                                            // If move to edge, then
                                            if (this.r.r.iEdge) {
                                                if (this.c-this.s < this.ma) {
                                                    this.c = this.ma;
                                                } else {
                                                    // If to cycle the value, then
                                                    if (this.r.r.iCycle) {
                                                        this.c = this.mi;
                                                    } else {
                                                        // Otherwise, complete
                                                        return undefined;
                                                    }
                                                }
                                            } else {
                                                // If to cycle the value, then
                                                if (this.r.r.iCycle) {
                                                    var ml = 10;
                                                    while (this.c>this.ma && ml>0) {
                                                        this.c-= (this.ma - this.mi);
                                                        ml--;
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
                                r:r,            // Rule
                                i:function() {  // Initial value
                                    return Number.parseInt(RED.util.evaluateNodeProperty(this.r.r.bInit, this.r.r.bInitType, node, this.r.msg));
                                },
                                c:undefined,    // Current
                                p:r.bIPos,      // Positive mode
                                mi:undefined,   // Min
                                ma:undefined,   // Max
                                s: undefined,   // Steps
                                e:function(rv,al) {
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
                                        if (this.p) {
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
                                        
                                        // If negative, then convert value to negative after validation.
                                        if (!this.p && this.s > 0)
                                            this.s=-this.s;

                                        if (al) {
                                            this.c+=this.s;
                                        }

                                        if (this.c<this.mi || this.c>this.ma) {
                                            this.c-=this.s;
                                            this.p = !this.p;

                                            // If move to edge, then
                                            if (this.r.r.bEdge) {
                                                if (!this.p && this.c < this.ma) {
                                                    this.c = this.ma;
                                                } else if (this.p && this.c > this.mi) {
                                                    this.c = this.mi;
                                                } else {
                                                    return this.e(false, true);
                                                }
                                            } else {
                                                return this.e(false, true);
                                            }
                                        }
                                    }

                                    return this.c;
                                }
                            };
                            break;
                        case 'fixed':
                            this.v = {
                                r:r,            // Rule
                                i:function() {  // Initial value
                                    return Number.parseInt(RED.util.evaluateNodeProperty(this.r.r.fInit, this.r.r.fInitType, node, this.r.msg), 10);
                                },
                                c:undefined,    // Current value
                                v:r.r.fValues,  // values array
                                e:function(rv, al) {
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
                                    if (!r && al && this.c<this.v.length) {
                                        this.c++;
                                    }

                                    // Validate value
                                    if (this.c < 0) this.c = 0;
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
                                    return RED.util.evaluateNodeProperty(v.v, v.t, node, this.r.msg);
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

            ri.init();
            r.push(ri);
        }
        
        this.on("input", function(msg, send, done) {
            node.done = done;

            lm = msg;
            var inp = RED.util.evaluateNodeProperty(config.inputValue, config.inputType, node, msg);
            
            if (so) {
                var res = [];
                r.forEach(e=> e.t(inp,msg,send,res) );
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
