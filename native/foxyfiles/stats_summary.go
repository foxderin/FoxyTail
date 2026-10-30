package main

import (
	"bytes"
	"context"
	"encoding/json"
	"errors"
	"math"
	"sort"
	"strconv"
	"time"
)

const statsMaxBuckets = 100000

type statsNumber struct {
	value float64
	kind  uint8 // null, false, true, number, or a value ordered after numbers in jq
}

func (n *statsNumber) UnmarshalJSON(body []byte) error {
	*n = statsNumber{}
	switch string(body) {
	case "null":
		return nil
	case "false":
		n.kind = 1
		return nil
	case "true":
		n.kind = 2
		return nil
	}
	value, err := strconv.ParseFloat(string(body), 64)
	if err != nil || math.IsInf(value, 0) || math.IsNaN(value) {
		n.kind = 4
		return nil
	}
	*n = statsNumber{value, 3}
	return nil
}

type statsToken string

func (s *statsToken) UnmarshalJSON(body []byte) error {
	var value any
	if err := json.Unmarshal(body, &value); err != nil {
		return err
	}
	if value == nil || value == false || value == "" {
		*s = ""
		return nil
	}
	encoded, err := json.Marshal(value)
	*s = statsToken(encoded)
	return err
}

type statsCounter struct {
	ID  statsIdentifier `json:"id"`
	UID statsIdentifier `json:"uid"`
	RX  statsNumber     `json:"rx"`
	TX  statsNumber     `json:"tx"`
}

type statsCounters []statsCounter

func (rows *statsCounters) UnmarshalJSON(body []byte) error {
	if len(body) > 0 && body[0] == '{' {
		decoder := json.NewDecoder(bytes.NewReader(body))
		if _, err := decoder.Token(); err != nil {
			return err
		}
		indices := map[string]int{}
		for decoder.More() {
			key, err := decoder.Token()
			if err != nil {
				return err
			}
			var row statsCounter
			if err := decoder.Decode(&row); err != nil {
				return err
			}
			if index, exists := indices[key.(string)]; exists {
				(*rows)[index] = row
			} else {
				indices[key.(string)] = len(*rows)
				*rows = append(*rows, row)
			}
		}
		_, err := decoder.Token()
		return err
	}
	if len(body) == 0 || body[0] != '[' {
		return nil
	}
	return json.Unmarshal(body, (*[]statsCounter)(rows))
}

type statsGeneration struct {
	Iface statsToken `json:"iface"`
	Peers statsToken `json:"peers"`
	UIDs  statsToken `json:"uids"`
}

func (g *statsGeneration) UnmarshalJSON(body []byte) error {
	if string(body) == "false" || string(body) == "null" {
		*g = statsGeneration{}
		return nil
	}
	type generation statsGeneration
	return json.Unmarshal(body, (*generation)(g))
}

type statsSample struct {
	Timestamp    float64         `json:"ts"`
	Iface        *statsCounter   `json:"iface"`
	Peers        statsCounters   `json:"peers"`
	UIDs         json.RawMessage `json:"uids"`
	UIDDirection statsIdentifier `json:"uidDirection"`
	Generation   statsGeneration `json:"generation"`
}

type statsPair struct {
	RX float64 `json:"rx"`
	TX float64 `json:"tx"`
}

type statsPeerTotal struct {
	ID string `json:"id"`
	statsPair
}

type statsUIDTotal struct {
	UID string `json:"uid"`
	statsPair
}

type statsDay struct {
	Date    string `json:"date"`
	Samples int    `json:"samples"`
	statsPair
}

type statsHour struct {
	Hour    int              `json:"hour"`
	Samples int              `json:"samples"`
	Iface   statsPair        `json:"iface"`
	Peers   []statsPeerTotal `json:"peers"`
}

type statsSummary struct {
	Date        string           `json:"date"`
	Attribution string           `json:"attribution"`
	Direction   string           `json:"direction"`
	Days        []statsDay       `json:"days"`
	Hours       []statsHour      `json:"hours"`
	TopN        []statsPeerTotal `json:"topn"`
	UIDs        []statsUIDTotal  `json:"uids"`
}

type statsPrevious struct {
	RX         statsNumber
	TX         statsNumber
	Generation statsToken
}

func statsDelta(old statsNumber, value statsNumber, changed bool) (float64, error) {
	if old.kind == 0 {
		return 0, nil
	}
	if value.kind < 2 {
		value = statsNumber{0, 3}
	}
	if value.kind != 3 {
		return 0, errors.New("invalid statistics counter arithmetic")
	}
	if changed || old.kind > value.kind || (old.kind == 3 && value.value < old.value) {
		return value.value, nil
	}
	if old.kind != 3 {
		return 0, errors.New("invalid statistics counter arithmetic")
	}
	return value.value - old.value, nil
}

func statsDifference(old statsPrevious, value statsCounter, generation statsToken) (statsPair, error) {
	changed := old.Generation != generation
	rx, rxErr := statsDelta(old.RX, value.RX, changed)
	tx, txErr := statsDelta(old.TX, value.TX, changed)
	return statsPair{rx, tx}, errors.Join(rxErr, txErr)
}

type statsIdentifier struct {
	value   string
	present bool
}

func (id *statsIdentifier) UnmarshalJSON(body []byte) error {
	id.present = true
	if len(body) > 0 && body[0] == '"' {
		return json.Unmarshal(body, &id.value)
	}
	var value any
	if err := json.Unmarshal(body, &value); err != nil {
		return err
	}
	encoded, err := json.Marshal(value)
	id.value = string(encoded)
	return err
}

func (id statsIdentifier) key() string {
	if !id.present {
		return "null"
	}
	return id.value
}

type statsAccumulator struct {
	result    statsSummary
	location  *time.Location
	lastIface statsPrevious
	lastPeers map[string]statsPrevious
	lastUIDs  map[string]statsPrevious
	days      map[string]*statsDay
	peers     map[string]statsPair
	uids      map[string]statsPair
	hours     [24]map[string]statsPair
	hourIDs   [24][]string
	buckets   int
	keyBytes  int
	sample    statsSample
	uidRows   statsCounters
}

func newStatsAccumulator(date string, location *time.Location) *statsAccumulator {
	a := &statsAccumulator{
		result:   statsSummary{Date: date, Attribution: "interval-end", Direction: "tx", Days: []statsDay{}, Hours: make([]statsHour, 24), TopN: []statsPeerTotal{}, UIDs: []statsUIDTotal{}},
		location: location, lastPeers: map[string]statsPrevious{}, lastUIDs: map[string]statsPrevious{},
		days: map[string]*statsDay{}, peers: map[string]statsPair{}, uids: map[string]statsPair{},
	}
	for hour := range a.result.Hours {
		a.result.Hours[hour] = statsHour{Hour: hour, Peers: []statsPeerTotal{}}
		a.hours[hour] = map[string]statsPair{}
	}
	return a
}

func (a *statsAccumulator) consume(body []byte) error {
	// Reuse row storage, but clear omitted fields so partial rows never inherit counters.
	peers := a.sample.Peers
	clear(peers)
	clear(a.uidRows)
	a.uidRows = a.uidRows[:0]
	a.sample = statsSample{Peers: peers[:0]}
	// A valid-JSON row that still cannot be decoded is skipped like torn JSON:
	// one wrong-type row must never fail every row that follows it.
	if err := json.Unmarshal(body, &a.sample); err != nil {
		return nil
	}
	if a.sample.UIDDirection.value == "tx" && len(a.sample.UIDs) != 0 {
		if err := json.Unmarshal(a.sample.UIDs, &a.uidRows); err != nil {
			return nil
		}
	}
	s := &a.sample
	numeric := func(values ...statsNumber) bool {
		for _, value := range values {
			if value.kind != 0 && value.kind != 3 {
				return false
			}
		}
		return true
	}
	if s.Iface != nil && !numeric(s.Iface.RX, s.Iface.TX) {
		return nil
	}
	for _, peer := range s.Peers {
		if !numeric(peer.RX, peer.TX) {
			return nil
		}
	}
	for _, uid := range a.uidRows {
		if !numeric(uid.RX, uid.TX) {
			return nil
		}
	}
	if s.Timestamp < -62135596800 || s.Timestamp > 253402300799 {
		return errors.New("statistics timestamp is outside the supported calendar")
	}
	stamp := time.Unix(int64(s.Timestamp), 0).In(a.location)
	date, hour := stamp.Format("2006-01-02"), stamp.Hour()
	day := a.days[date]
	if day == nil {
		day = &statsDay{Date: date}
		a.days[date] = day
		a.buckets++
	}
	if s.Iface != nil {
		value, err := statsDifference(a.lastIface, *s.Iface, s.Generation.Iface)
		if err != nil {
			return err
		}
		day.Samples++
		day.RX += value.RX
		day.TX += value.TX
		if date == a.result.Date {
			bucket := &a.result.Hours[hour]
			bucket.Samples++
			bucket.Iface.RX += value.RX
			bucket.Iface.TX += value.TX
		}
		a.keyBytes += len(s.Generation.Iface) - len(a.lastIface.Generation)
		a.lastIface = statsPrevious{s.Iface.RX, s.Iface.TX, s.Generation.Iface}
	}
	for _, peer := range s.Peers {
		id := peer.ID.key()
		value, err := statsDifference(a.lastPeers[id], peer, s.Generation.Peers)
		if err != nil {
			return err
		}
		total, exists := a.peers[id]
		if !exists {
			a.buckets++
			a.keyBytes += len(id)
		}
		total.RX += value.RX
		total.TX += value.TX
		a.peers[id] = total
		if date == a.result.Date {
			total, exists = a.hours[hour][id]
			if !exists {
				a.buckets++
				a.keyBytes += len(id)
				a.hourIDs[hour] = append(a.hourIDs[hour], id)
			}
			total.RX += value.RX
			total.TX += value.TX
			a.hours[hour][id] = total
		}
	}
	// Duplicate IDs in one sample all compare to the preceding sample, as in jq.
	for _, peer := range s.Peers {
		a.keyBytes += len(s.Generation.Peers) - len(a.lastPeers[peer.ID.key()].Generation)
		a.lastPeers[peer.ID.key()] = statsPrevious{peer.RX, peer.TX, s.Generation.Peers}
	}
	if s.UIDDirection.value == "tx" {
		for _, uid := range a.uidRows {
			id := uid.UID.key()
			value, err := statsDifference(a.lastUIDs[id], uid, s.Generation.UIDs)
			if err != nil {
				return err
			}
			total, exists := a.uids[id]
			if !exists {
				a.buckets++
				a.keyBytes += len(id)
			}
			total.TX += value.TX
			a.uids[id] = total
		}
		for _, uid := range a.uidRows {
			a.keyBytes += len(s.Generation.UIDs) - len(a.lastUIDs[uid.UID.key()].Generation)
			a.lastUIDs[uid.UID.key()] = statsPrevious{uid.RX, uid.TX, s.Generation.UIDs}
		}
	}
	if a.buckets > statsMaxBuckets || a.keyBytes > 8<<20 {
		return errors.New("statistics aggregation exceeds bucket limit")
	}
	return nil
}

func (a *statsAccumulator) finish(ctx context.Context) (statsSummary, error) {
	if err := ctx.Err(); err != nil {
		return statsSummary{}, err
	}
	for _, day := range a.days {
		a.result.Days = append(a.result.Days, *day)
	}
	sort.Slice(a.result.Days, func(i, j int) bool { return a.result.Days[i].Date < a.result.Days[j].Date })
	for hour, peers := range a.hours {
		for _, id := range a.hourIDs[hour] {
			a.result.Hours[hour].Peers = append(a.result.Hours[hour].Peers, statsPeerTotal{id, peers[id]})
		}
	}
	for id, value := range a.peers {
		if value.RX+value.TX > 0 {
			a.result.TopN = append(a.result.TopN, statsPeerTotal{id, value})
		}
	}
	sort.Slice(a.result.TopN, func(i, j int) bool {
		x, y := a.result.TopN[i], a.result.TopN[j]
		if x.RX+x.TX == y.RX+y.TX {
			return x.ID < y.ID
		}
		return x.RX+x.TX > y.RX+y.TX
	})
	for id, value := range a.uids {
		if value.TX > 0 {
			a.result.UIDs = append(a.result.UIDs, statsUIDTotal{id, value})
		}
	}
	sort.Slice(a.result.UIDs, func(i, j int) bool {
		x, y := a.result.UIDs[i], a.result.UIDs[j]
		if x.TX == y.TX {
			return x.UID < y.UID
		}
		return x.TX > y.TX
	})
	return a.result, nil
}
