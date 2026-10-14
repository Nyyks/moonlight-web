/*
 * MoonlightWeb — native capture & encoding engine.
 * Copyright (C) 2026 Bruno Martin <brunoocto@gmail.com>
 *
 * This program is free software: you can redistribute it and/or modify it
 * under the terms of the GNU General Public License as published by the Free
 * Software Foundation, either version 3 of the License, or (at your option)
 * any later version.
 *
 * This program is distributed in the hope that it will be useful, but WITHOUT
 * ANY WARRANTY; without even the implied warranty of MERCHANTABILITY or FITNESS
 * FOR A PARTICULAR PURPOSE. See the GNU General Public License for more details.
 *
 * You should have received a copy of the GNU General Public License along with
 * this program. If not, see <https://www.gnu.org/licenses/>.
 */

#include "core/ClickTrace.h"
#include "native_test_framework.h"

#include <string>

using mw::native::ClickTrace;

void run_click_trace_tests()
{
    SECTION("ClickTrace — a press and a capture, a field not known left empty");
    {
        ClickTrace trace;
        trace.press(0, 1000, 1012);
        ClickTrace::Row row;
        row.kind = ClickTrace::Kind::Capture;
        row.us = 9000;
        row.startUs = 2000;
        row.status = "ok";
        row.presentUs = 8500;
        row.presentRawUs = 8500;
        row.accumulated = 1;
        row.vblankUs = 8333;
        row.periodUs = 8333;
        row.composeUs = 8400;
        row.composedFrames = 77;
        trace.add(row);
        const std::string csv = trace.csv();
        const std::string header =
            "kind,us,startUs,queuedUs,status,presentUs,presentRawUs,mouseUs,accumulated,"
            "vblankUs,periodUs,composeUs,composedFrames,deliveredUs,locked,latticeUs\n";
        CHECK_EQ(csv.substr(0, header.size()), header);
        CHECK_EQ(csv.substr(header.size()),
                 std::string("press,1012,1000,,,,,,,,,,,,,\n"
                             "capture,9000,2000,,ok,8500,8500,,1,8333,8333,8400,77,,,\n"));
        CHECK_EQ(trace.rows(), size_t(2));
    }

    SECTION("ClickTrace — macOS: the frame's delivery, no composition");
    {
        ClickTrace trace;
        ClickTrace::Row row;
        row.kind = ClickTrace::Kind::Capture;
        row.us = 9000;
        row.startUs = 8000;
        row.status = "ok";
        row.presentUs = 8500;
        row.presentRawUs = 8500;
        row.accumulated = 2;
        row.vblankUs = 8333;
        row.periodUs = 16667;
        row.composedFrames = 5;
        row.deliveredUs = 8900;
        trace.add(row);
        const std::string csv = trace.csv();
        CHECK(csv.find("\ncapture,9000,8000,,ok,8500,8500,,2,8333,16667,,5,8900,,\n") !=
              std::string::npos);
    }

    SECTION("ClickTrace — a press queued for the follower keeps the moment it was queued");
    {
        ClickTrace trace;
        trace.press(990, 1000, 1012);
        const std::string csv = trace.csv();
        CHECK(csv.find("press,1012,1000,990,") != std::string::npos);
    }

    SECTION("ClickTrace — the window after a press: its presses, the gate's pictures and its own");
    {
        ClickTrace trace;
        trace.admit("press", 1000, 0);
        trace.admit("grid", 2100, 2000);
        trace.admit("window", 6250, 6166);
        const std::string csv = trace.csv();
        CHECK(csv.find("\nadmit,1000,,,press,,,,,,,,,,,\n") != std::string::npos);
        CHECK(csv.find("\nadmit,2100,,,grid,2000,,,,,,,,,,\n") != std::string::npos);
        CHECK(csv.find("\nadmit,6250,,,window,6166,,,,,,,,,,\n") != std::string::npos);
        CHECK_EQ(trace.rows(), size_t(3));
    }

    SECTION("ClickTrace — the gate locked on the display's presents, or not, and the lattice");
    {
        ClickTrace trace;
        trace.admit("grid", 2100, 2000, 1, 2003);
        trace.admit("window", 6250, 6166, 0, 6170);
        trace.admit("grid", 9100, 9000, 0, 0);
        const std::string csv = trace.csv();
        CHECK(csv.find("\nadmit,2100,,,grid,2000,,,,,,,,,1,2003\n") != std::string::npos);
        CHECK(csv.find("\nadmit,6250,,,window,6166,,,,,,,,,0,6170\n") != std::string::npos);
        CHECK(csv.find("\nadmit,9100,,,grid,9000,,,,,,,,,0,\n") != std::string::npos);
    }

    SECTION("ClickTrace — past its bound, rows are counted and not kept");
    {
        ClickTrace trace;
        for (size_t i = 0; i < ClickTrace::kMaxRows + 5; ++i)
            trace.press(0, 1, 2);
        CHECK_EQ(trace.rows(), ClickTrace::kMaxRows);
        CHECK_EQ(trace.dropped(), size_t(5));
    }
}
