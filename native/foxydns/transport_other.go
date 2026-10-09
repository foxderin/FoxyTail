//go:build !linux

package main

import (
	"context"
	"net"
)

type Interceptor struct{}

func NewInterceptor(uint16, *flowJournal) (*Interceptor, error) { return nil, ErrUnsupported }
func ProbeCapabilities(uint16) error                            { return ErrUnsupported }
func (*Interceptor) Close() error                               { return nil }
func (*Interceptor) Health() error                              { return ErrUnsupported }
func (*Interceptor) Lookup(string, net.Addr, net.Addr) (FlowContext, error) {
	return FlowContext{}, ErrUnsupported
}
func DialOriginal(context.Context, string, FlowContext) (net.Conn, error) {
	return nil, ErrUnsupported
}
